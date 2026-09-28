import { createHash, randomUUID } from 'crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { acquirePersistenceLease } from './persistenceLock.js'
import { inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { durableWrite, runtimeStateRoot } from './runtimeState.js'

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

function identity(cwd: string): string {
  let canonical = resolve(cwd)
  try { canonical = realpathSync(canonical) } catch { canonical = resolve(cwd) }
  if (process.platform === 'win32') canonical = canonical.toLowerCase()
  return canonical
}

function location(cwd: string, root = runtimeStateRoot()): string {
  return join(root, 'workspaces', createHash('sha256').update(identity(cwd)).digest('hex') + '.json')
}

export function readWorkspaceLease(cwd: string, root?: string): WorkspaceLeaseRecord | undefined {
  const path = location(cwd, root)
  if (!existsSync(path)) return undefined
  if (statSync(path).size > 16 * 1024) throw new Error(`Workspace coordination record byte limit exceeded: ${path}`)
  const record = JSON.parse(readFileSync(path, 'utf8')) as WorkspaceLeaseRecord
  const text = (value: unknown, max = 1024): value is string => typeof value === 'string' && value.length > 0 && value.length <= max
  if (!record || Array.isArray(record) || record.schemaVersion !== 1 || !record.owner || !Number.isSafeInteger(record.owner.pid) || record.owner.pid < 1 || !text(record.owner.hostname, 256) || !text(record.owner.birthId, 256) || !text(record.workspace, 8192) || identity(record.workspace) !== identity(cwd) || !text(record.epoch, 128) || !text(record.heartbeat) || !Number.isFinite(Date.parse(record.heartbeat)) || !text(record.reason, 2048) || !['held', 'released', 'needs_recovery'].includes(record.state)) throw new Error(`Workspace coordination data is invalid: ${path}`)
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
    record.recovery = { decision: options.decision, artifactVersion: options.artifactVersion, at: new Date().toISOString() }
    record.state = options.decision === 'keep' ? 'needs_recovery' : 'released'
    record.epoch = randomUUID()
    durableWrite(location(cwd, options.stateRoot), record)
  } finally { guard.release() }
}
