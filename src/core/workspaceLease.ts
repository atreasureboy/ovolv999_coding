import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { acquirePersistenceLease } from './persistenceLock.js'
import { inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { durableWrite, runtimeStateRoot } from './runtimeState.js'
import { RunStore, operationNeedsRecovery } from './runStore.js'

const runInspectionCache = new Map<string, { fingerprint: string; workspace: string; pending: boolean }>()

function runFingerprint(path: string): string {
  const stat = statSync(path)
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':')
}

export interface WorkspaceLeaseRecord {
  schemaVersion: 1
  workspace: string
  owner: ProcessIdentity
  epoch: string
  state: 'held' | 'released' | 'needs_recovery'
  heartbeat: string
  reason: string
  recovery?: { decision: string; artifactVersion: string; at: string }
}

export function canonicalWorkspaceIdentity(cwd: string): string {
  let canonical = resolve(cwd)
  try { canonical = realpathSync(canonical) } catch { canonical = resolve(cwd) }
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return canonical
}

function location(cwd: string, root = runtimeStateRoot()): string {
  return join(root, 'workspaces', createHash('sha256').update(canonicalWorkspaceIdentity(cwd)).digest('hex') + '.json')
}

async function assertOperationsReconciled(cwd: string, root: string, recovery: boolean): Promise<void> {
  const runs = join(root, 'runs')
  if (!existsSync(runs)) return
  const names = readdirSync(runs).filter(name => name.endsWith('.json'))
  const unresolved: string[] = []
  const workspace = canonicalWorkspaceIdentity(cwd)
  const canonical = new Map<string, string>()
  for (const name of names) {
    const path = join(runs, name)
    const fingerprint = runFingerprint(path)
    const cached = runInspectionCache.get(path)
    if (cached?.fingerprint === fingerprint) {
      let target = canonical.get(cached.workspace)
      if (!target && !cached.pending && !existsSync(cached.workspace)) continue
      if (!target) { target = canonicalWorkspaceIdentity(cached.workspace); canonical.set(cached.workspace, target) }
      if (target !== workspace) continue
    }
    const record = RunStore.inspect(path, { deriveStatus: false })
    const operations = Object.entries(record.operations).filter(([, operation]) => operationNeedsRecovery(operation))
    if (fingerprint !== runFingerprint(path)) { runInspectionCache.delete(path); throw new Error('Run record changed during workspace inspection; retry without reusing the workspace') }
    if (runInspectionCache.has(path) || runInspectionCache.size < 20000) runInspectionCache.set(path, { fingerprint, workspace: record.workspace, pending: operations.length > 0 })
    if (!operations.length) continue
    let target = canonical.get(record.workspace)
    if (!target) { target = canonicalWorkspaceIdentity(record.workspace); canonical.set(record.workspace, target) }
    if (target !== workspace) continue
    const explicit = operations.some(([, operation]) => operation.receipt !== undefined)
    if (!recovery && record.status === 'running' && !explicit && await inspectProcessIdentity(record.owner) === 'matching') continue
    for (const [operationId, operation] of operations) unresolved.push(`${record.runId}/${operationId} (${operation.name}; receipt=${operation.receipt?.status ?? 'absent'}; effects=${operation.receipt?.effects ?? 'unknown'})`)
  }
  if (unresolved.length) {
    const error = new Error(`Workspace needs operation reconciliation before reuse: ${unresolved.join(', ')}. Use --recover-operation for each exact operation; physical-stop confirmation does not resolve unknown effects`)
    error.name = 'WorkspaceUnavailableError'
    throw error
  }
}

export function readWorkspaceLease(cwd: string, root?: string): WorkspaceLeaseRecord | undefined {
  const path = location(cwd, root)
  if (!existsSync(path)) return undefined
  if (statSync(path).size > 16 * 1024) throw new Error(`Workspace coordination record byte limit exceeded: ${path}`)
  const record = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceLeaseRecord
  const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  if (!record || Array.isArray(record) || record.schemaVersion !== 1 || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid < 1 || !text(record.owner.hostname, 256) || !text(record.owner.birthId, 256) || !text(record.workspace, 8192) || canonicalWorkspaceIdentity(record.workspace) !== canonicalWorkspaceIdentity(cwd) || !text(record.epoch, 128) || !text(record.heartbeat) || !Number.isFinite(Date.parse(record.heartbeat)) || !text(record.reason, 2048) || !['held', 'released', 'needs_recovery'].includes(record.state)) throw new Error(`Workspace coordination data is invalid: ${path}`)
  if (record.recovery && (!['keep', 'cancel', 'continue'].includes(record.recovery.decision) || !text(record.recovery.artifactVersion, 128) || !Number.isFinite(Date.parse(record.recovery.at)))) throw new Error(`Workspace recovery data is invalid: ${path}`)
  return record
}

export async function acquireWorkspaceLease(cwd: string, options: { signal?: AbortSignal; stateRoot?: string; reason?: string } = {}): Promise<{ epoch: string; assertOwned(): void; release(): void; quarantine(): void }> {
  const path = location(cwd, options.stateRoot)
  const guard = await acquirePersistenceLease(path, { signal: options.signal, timeoutMs: 1_800_000 })
  let timer: ReturnType<typeof setInterval> | undefined
  let failure: unknown
  try {
    const prior = readWorkspaceLease(cwd, options.stateRoot)
    if (prior && prior.state !== 'released') {
      const error = new Error(`Workspace needs recovery; previous epoch ${prior.epoch}, owner ${prior.owner.pid}. Confirm physical resources stopped before explicit reconciliation: ${path}`)
      error.name = 'WorkspaceUnavailableError'
      throw error
    }
    await assertOperationsReconciled(cwd, options.stateRoot ?? runtimeStateRoot(), false)
    const record: WorkspaceLeaseRecord = { schemaVersion: 1, workspace: resolve(cwd), owner: guard.owner, epoch: randomUUID(), state: 'held', heartbeat: new Date().toISOString(), reason: options.reason ?? 'workspace operation' }
    durableWrite(path, record)
    const assertOwned = (): void => {
      if (failure) throw failure instanceof Error ? failure : new Error('Workspace persistence failed')
      guard.assertOwned()
      const current = readWorkspaceLease(cwd, options.stateRoot)
      if (current?.epoch !== record.epoch || current.state !== 'held') throw new Error('Workspace fencing token changed; result rejected')
    }
    timer = setInterval(() => {
      try { assertOwned(); record.heartbeat = new Date().toISOString(); durableWrite(path, record) } catch (error) { failure = error; clearInterval(timer) }
    }, 5000)
    timer.unref()
    return { epoch: record.epoch, assertOwned, quarantine() {
      clearInterval(timer)
      try { assertOwned(); record.state = 'needs_recovery'; durableWrite(path, record) } finally { guard.release() }
    }, release() {
      clearInterval(timer)
      try { assertOwned(); record.state = 'released'; durableWrite(path, record) } finally { guard.release() }
    } }
  } catch (error) { clearInterval(timer); guard.release(); throw error }
}

export async function reconcileWorkspace(cwd: string, options: { stateRoot?: string; expectedEpoch: string; decision: 'keep' | 'cancel' | 'continue'; physicalStopConfirmed: boolean; artifactVersion: string }): Promise<void> {
  if (!['keep', 'cancel', 'continue'].includes(options.decision)) throw new Error('Unknown recovery decision')
  const guard = await acquirePersistenceLease(location(cwd, options.stateRoot))
  try {
    const record = readWorkspaceLease(cwd, options.stateRoot)
    if (!record || record.epoch !== options.expectedEpoch) throw new Error('Recovery epoch changed')
    const status = await inspectProcessIdentity(record.owner)
    if (status === 'matching' || status === 'unknown') throw new Error('Owner is alive or unverified; cannot reconcile')
    if (!options.physicalStopConfirmed || !options.artifactVersion) throw new Error('Physical resource stop and current artifact version must be confirmed')
    if (options.decision !== 'keep') await assertOperationsReconciled(cwd, options.stateRoot ?? runtimeStateRoot(), true)
    record.recovery = { decision: options.decision, artifactVersion: options.artifactVersion, at: new Date().toISOString() }
    record.state = options.decision === 'keep' ? 'needs_recovery' : 'released'
    record.epoch = randomUUID()
    durableWrite(location(cwd, options.stateRoot), record)
  } finally { guard.release() }
}
