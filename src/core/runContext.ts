import { randomUUID } from 'crypto'
import { realpathSync } from 'fs'
import { resolve } from 'path'
import { FileReadState } from './fileState.js'
import type { EngineConfig, ToolResult, TurnResult, WorkspaceBinding } from './types.js'
import { acquireWorkspaceLease } from './workspaceLease.js'
import { createProcessScope } from './executionBackend.js'
import { RunStore } from './runStore.js'
import { runtimeStateRoot } from './runtimeState.js'

export interface RunContext {
  runId: string
  parentRunId?: string
  familyId: string
  workspace: WorkspaceBinding
  controller: AbortController
  fileState: FileReadState
  policyRevision: number
  pending: Map<string, Promise<unknown>>
  toolFailures: Map<string, ToolResult>
  mutationAttempted: boolean
  result?: TurnResult
  store?: RunStore
  detachParent: () => void
}

export function workspaceIdentity(cwd: string): string {
  let path = resolve(cwd)
  try { path = realpathSync(path) } catch { path = resolve(cwd) }
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function createRunContext(config: EngineConfig): RunContext {
  const runId = randomUUID()
  const controller = new AbortController()
  const onAbort = (): void => controller.abort(config.parentSignal?.reason)
  if (config.parentSignal?.aborted) onAbort()
  else config.parentSignal?.addEventListener('abort', onAbort, { once: true })
  return {
    runId, parentRunId: config.parentRunId, familyId: config.runFamilyId ?? runId,
    workspace: { ...config.workspace, cwd: resolve(config.cwd) }, controller,
    fileState: new FileReadState(), policyRevision: 0, pending: new Map(),
    toolFailures: new Map(), mutationAttempted: false,
    detachParent: () => config.parentSignal?.removeEventListener('abort', onAbort),
  }
}

const quarantined = new Map<string, Set<Promise<unknown>>>()

export function quarantineWorkspace(cwd: string, promise: Promise<unknown>): void {
  const key = workspaceIdentity(cwd)
  const pending = quarantined.get(key) ?? new Set<Promise<unknown>>()
  quarantined.set(key, pending)
  pending.add(promise)
  const settled = (): void => {
    pending.delete(promise)
    if (!pending.size) quarantined.delete(key)
  }
  void promise.then(settled, settled)
}

export function isWorkspaceQuarantined(cwd: string): boolean {
  return (quarantined.get(workspaceIdentity(cwd))?.size ?? 0) > 0
}

export function quarantineRun(run: RunContext): void {
  if (!run.pending.size) return
  const key = workspaceIdentity(run.workspace.cwd)
  const pending = quarantined.get(key) ?? new Set<Promise<unknown>>()
  quarantined.set(key, pending)
  for (const promise of run.pending.values()) {
    pending.add(promise)
    const settled = (): void => {
      pending.delete(promise)
      if (!pending.size) quarantined.delete(key)
    }
    void promise.then(settled, settled)
  }
}

export async function runOperation<T>(run: RunContext, name: string, operation: () => Promise<T>, timeoutMs: number, graceMs: number): Promise<T> {
  run.controller.signal.throwIfAborted()
  const id = `${name}:${randomUUID()}`
  const promise = Promise.resolve().then(operation)
  run.pending.set(id, promise)
  const settled = (): void => { run.pending.delete(id) }
  void promise.then(settled, settled)
  let timeout: ReturnType<typeof setTimeout> | undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  let onAbort: () => void = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          grace = setTimeout(() => {
            quarantineRun(run)
            reject(new Error(`Cancelled ${name}; unfinished resources: ${[...run.pending.keys()].join(', ')}`))
          }, graceMs)
        }
        run.controller.signal.addEventListener('abort', onAbort, { once: true })
        if (run.controller.signal.aborted) onAbort()
        timeout = setTimeout(() => run.controller.abort(`timeout:${name}`), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (grace) clearTimeout(grace)
    run.controller.signal.removeEventListener('abort', onAbort)
  }
}

interface Lease {
  familyId: string
  write: boolean
}

interface Gate {
  active: Set<Lease>
  waiters: Set<() => void>
}

const gates = new Map<string, Gate>()
const durableLeases = new Map<string, { references: number; unknown: boolean; ready: ReturnType<typeof acquireWorkspaceLease> }>()

export function initializeRunStore(run: RunContext): void {
  run.store = new RunStore(runtimeStateRoot(), { runId: run.runId, parentRunId: run.parentRunId, workspace: run.workspace.cwd })
}

export async function withWorkspaceAccess<T>(cwd: string, familyId: string, write: boolean, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  const key = workspaceIdentity(cwd)
  const gate = gates.get(key) ?? { active: new Set<Lease>(), waiters: new Set<() => void>() }
  gates.set(key, gate)
  const lease = { familyId, write }
  await new Promise<void>((accept, reject) => {
    const onAbort = (): void => {
      gate.waiters.delete(attempt)
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Cancelled while waiting for workspace access'))
    }
    const attempt = (): void => {
      if (signal.aborted) { onAbort(); return }
      if (isWorkspaceQuarantined(cwd)) {
        gate.waiters.delete(attempt)
        signal.removeEventListener('abort', onAbort)
        const error = new Error('Workspace is quarantined by unfinished operations')
        error.name = 'WorkspaceUnavailableError'
        reject(error)
        return
      }
      if ([...gate.active].some(active => active.familyId !== familyId && (active.write || write))) return
      gate.active.add(lease)
      gate.waiters.delete(attempt)
      signal.removeEventListener('abort', onAbort)
      accept()
    }
    gate.waiters.add(attempt)
    signal.addEventListener('abort', onAbort, { once: true })
    attempt()
  })
  const durableKey = key + ':' + familyId
  let durable = durableLeases.get(durableKey)
  if (!durable) {
    durable = { references: 0, unknown: false, ready: acquireWorkspaceLease(cwd, { signal, reason: write ? 'workspace write' : 'workspace read' }) }
    durableLeases.set(durableKey, durable)
  }
  durable.references++
  const scope = createProcessScope()
  let operationStarted = false
  const release = async (): Promise<void> => {
    try {
      durable.references--
      if (!durable.references) {
        durableLeases.delete(durableKey)
        const owned = await durable.ready
        if (durable.unknown) owned.quarantine()
        else owned.release()
      }
    } finally {
      gate.active.delete(lease)
      for (const waiter of [...gate.waiters]) waiter()
      if (!gate.active.size && !gate.waiters.size) gates.delete(key)
    }
  }
  try {
    const owned = await durable.ready
    signal.throwIfAborted()
    if (isWorkspaceQuarantined(cwd)) {
      const error = new Error('Workspace is quarantined by unfinished operations')
      error.name = 'WorkspaceUnavailableError'
      throw error
    }
    owned.assertOwned()
    operationStarted = true
    const result = await scope.run(operation)
    owned.assertOwned()
    return result
  } catch (error) {
    if (operationStarted && write) durable.unknown = true
    throw error
  } finally {
    if (scope.pending.size) {
      const physical = Promise.all([...scope.pending]).then(release, () => new Promise<void>(() => undefined))
      quarantineWorkspace(cwd, physical)
      void physical.catch(() => undefined)
    } else await release()
  }
}
