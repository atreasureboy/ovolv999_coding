import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { RunStore, operationNeedsRecovery, type RunOperation } from './runStore.js'
import { runtimeStateRoot } from './runtimeState.js'
import { inspectProcessIdentity } from './processIdentity.js'
import { canonicalWorkspaceIdentity, readWorkspaceLease, reconcileWorkspace } from './workspaceLease.js'
import { captureArtifactVersion } from './verification.js'
import { reconcileOperation } from './operationRecovery.js'

const MAX_DISPLAY_RUNS = 1000
const MAX_DISPLAY_OPERATIONS = 1000
const MAX_DISPLAY_BYTES = 4 * 1024 * 1024

function operationView(operationId: string, operation: RunOperation): Record<string, unknown> {
  const basic = { operationId, name: operation.name, summary: operation.summary ?? `${operation.name}; legacy intent without argument digest`, inputDigest: operation.inputDigest, receiptStatus: operation.receipt?.status ?? 'absent', effects: operation.receipt?.effects ?? 'unknown', replay: operation.readOnly ? 'read may be repeated after reconciliation' : 'forbidden' }
  const details = { ...basic, affectedPaths: operation.affectedPaths ?? [], resourceIds: operation.resourceIds ?? [], fileEvidence: operation.fileEvidence, reconciliations: operation.reconciliations?.slice(-1) ?? [], reconciliationCount: operation.reconciliations?.length ?? 0 }
  if (Buffer.byteLength(JSON.stringify(details)) <= 64 * 1024) return details
  return { ...basic, affectedPathCount: operation.affectedPaths?.length ?? 0, resourceCount: operation.resourceIds?.length ?? 0, reconciliationCount: operation.reconciliations?.length ?? 0, detailsTruncated: true, detail: 'Inspect the run record for full bounded references and evidence' }
}

export async function inspectRuntime(cwd: string, root = runtimeStateRoot(), filter: { runId?: string; operationId?: string } = {}): Promise<Record<string, unknown>> {
  const workspace = resolve(cwd)
  const lease = readWorkspaceLease(workspace, root)
  const runsPath = join(root, 'runs')
  const pendingRuns: Array<Record<string, unknown>> = []
  const settledRuns: Array<Record<string, unknown>> = []
  const corruptRuns: Array<Record<string, unknown>> = []
  let matchedRunCount = 0
  let pendingOperationCount = 0
  let displayedOperationCount = 0
  let pendingBytes = 0
  let corruptRecordCount = 0
  const workspaceIdentity = canonicalWorkspaceIdentity(workspace)
  if (existsSync(runsPath)) {
    const names = readdirSync(runsPath).filter(name => name.endsWith('.json'))
    for (const name of names) {
      try {
        const path = join(runsPath, name)
        const record = RunStore.inspect(path)
        if (canonicalWorkspaceIdentity(record.workspace) !== workspaceIdentity) continue
        matchedRunCount++
        const pending = Object.entries(record.operations).filter(([, operation]) => operationNeedsRecovery(operation))
        pendingOperationCount += pending.length
        if (filter.runId && filter.runId !== record.runId) continue
        const visible: Array<Record<string, unknown>> = []
        const view = { runId: record.runId, parentRunId: record.parentRunId, status: record.status, revision: record.revision, epoch: record.epoch, recordPath: path, pendingOperationCount: pending.length, pendingOperations: visible }
        if (!pending.length) {
          settledRuns.push(view)
          if (settledRuns.length > MAX_DISPLAY_RUNS) settledRuns.shift()
          continue
        }
        if (pendingRuns.length >= MAX_DISPLAY_RUNS) continue
        let bytes = Buffer.byteLength(JSON.stringify(view))
        if (pendingBytes + bytes > MAX_DISPLAY_BYTES - 64 * 1024) continue
        for (const [operationId, operation] of pending) {
          if (filter.operationId && filter.operationId !== operationId) continue
          if (displayedOperationCount >= MAX_DISPLAY_OPERATIONS) break
          const item = operationView(operationId, operation)
          const itemBytes = Buffer.byteLength(JSON.stringify(item)) + 1
          if (pendingBytes + bytes + itemBytes > MAX_DISPLAY_BYTES - 64 * 1024) break
          visible.push(item)
          bytes += itemBytes
          displayedOperationCount++
        }
        pendingBytes += bytes
        pendingRuns.push(view)
      } catch {
        corruptRecordCount++
        if (corruptRuns.length < MAX_DISPLAY_RUNS) corruptRuns.push({ record: name, status: 'corrupt', scope: 'unverified', recovery: 'preserve and inspect the record before workspace reuse' })
      }
    }
  }
  const ownerStatus = lease ? await inspectProcessIdentity(lease.owner) : undefined
  const runs: Array<Record<string, unknown>> = []
  let bytes = 0
  for (const view of [...pendingRuns, ...corruptRuns, ...settledRuns.reverse()]) {
    const size = Buffer.byteLength(JSON.stringify(view)) + 1
    if (runs.length >= MAX_DISPLAY_RUNS || bytes + size > MAX_DISPLAY_BYTES - 32 * 1024) break
    runs.push(view)
    bytes += size
  }
  const visibleMatched = runs.filter(run => run.status !== 'corrupt').length
  const visibleOperations = runs.reduce((count, run) => count + (Array.isArray(run.pendingOperations) ? run.pendingOperations.length : 0), 0)
  const omittedRunCount = matchedRunCount - visibleMatched
  const omittedPendingOperationCount = pendingOperationCount - visibleOperations
  const omittedCorruptRecordCount = corruptRecordCount - runs.filter(run => run.status === 'corrupt').length
  const truncated = omittedRunCount > 0 || omittedPendingOperationCount > 0 || omittedCorruptRecordCount > 0
  const unsettled = pendingOperationCount > 0 || corruptRecordCount > 0
  return { schemaVersion: 1, workspace, stateRoot: root, accepting: (!lease || lease.state === 'released') && !unsettled, lease, ownerStatus, runs, matchedRunCount, pendingOperationCount, corruptRecordCount, omittedRunCount, omittedPendingOperationCount, omittedCorruptRecordCount, truncated, truncatedAt: MAX_DISPLAY_RUNS, maxDisplayOperations: MAX_DISPLAY_OPERATIONS, maxDisplayBytes: MAX_DISPLAY_BYTES, filter }
}

export async function handleRuntimeCommand(args: readonly string[], write: (text: string) => void = text => { process.stdout.write(text) }): Promise<boolean> {
  const status = args.indexOf('--runtime-status')
  const recover = args.indexOf('--recover-workspace')
  const recoverOperation = args.indexOf('--recover-operation')
  if (status < 0 && recover < 0 && recoverOperation < 0) return false
  const option = (name: string): string | undefined => { const at = args.indexOf(name); const value = at < 0 ? undefined : args[at + 1]; return value?.startsWith('--') ? undefined : value }
  if (recoverOperation >= 0) {
    if (recover >= 0) throw new Error('Reconcile one operation or workspace at a time')
    const runId = option('--recover-operation')
    const operationId = option('--operation-id')
    const expectedEpoch = option('--epoch')
    const revision = option('--revision')
    const decision = option('--decision')
    if (!runId || !/^[a-zA-Z0-9][\w-]{0,127}$/.test(runId) || !operationId || !expectedEpoch || !revision || !/^\d+$/.test(revision) || !Number.isSafeInteger(Number(revision)) || !['keep', 'cancel', 'continue'].includes(decision ?? '')) throw new Error('Operation recovery requires a valid run ID, --operation-id, --epoch, --revision and --decision keep|cancel|continue')
    const path = join(runtimeStateRoot(), 'runs', runId + '.json')
    const record = RunStore.inspect(path)
    const result = await reconcileOperation(path, operationId, { expectedEpoch, expectedRevision: Number(revision), decision: decision as 'keep' | 'cancel' | 'continue', physicalStopConfirmed: args.includes('--confirm-physical-stop') })
    write(JSON.stringify({ ...await inspectRuntime(record.workspace), reconciliation: { runId, operationId, ...result } }, null, 2) + '\n')
    return true
  }
  const index = recover >= 0 ? recover : status
  const value = args[index + 1]
  if (recover >= 0 && (!value || value.startsWith('--'))) throw new Error('--recover-workspace requires a workspace path')
  const cwd = value && !value.startsWith('--') ? resolve(value) : process.cwd()
  if (recover >= 0) {
    const expectedEpoch = option('--epoch')
    const decision = option('--decision')
    if (!expectedEpoch || !['keep', 'cancel', 'continue'].includes(decision ?? '')) throw new Error('Recovery requires --epoch and --decision keep|cancel|continue')
    if (!args.includes('--confirm-physical-stop')) throw new Error('Confirm that all physical operations and descendants stopped with --confirm-physical-stop')
    const artifactVersion = await captureArtifactVersion(cwd)
    await reconcileWorkspace(cwd, { expectedEpoch, decision: decision as 'keep' | 'cancel' | 'continue', physicalStopConfirmed: true, artifactVersion })
  }
  const runId = option('--run-id')
  const operationId = option('--operation-id')
  if ((runId && !/^[a-zA-Z0-9][\w-]{0,127}$/.test(runId)) || (operationId && !runId)) throw new Error('Targeted runtime inspection requires --run-id and optionally --operation-id')
  write(JSON.stringify(await inspectRuntime(cwd, runtimeStateRoot(), { runId, operationId }), null, 2) + '\n')
  return true
}
