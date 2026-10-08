import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { approvalInputDigest } from './approvalBroker.js'
import { RunStore, type OperationRecoveryOptions, type OperationSettlement, type RunOperation } from './runStore.js'

export type { OperationFileEvidence, OperationFileObservation } from './runStore.js'

export function digestOperationInput(tool: string, workspace: string, input: Record<string, unknown>): string {
  if (!tool.trim() || tool.length > 256 || !workspace.trim() || workspace.length > 32768) throw new Error('Invalid operation identity')
  return approvalInputDigest({ tool, workspace: resolve(workspace), input })
}

function samePath(left: string, right: string): boolean {
  const normalize = (path: string): string => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  return normalize(left) === normalize(right)
}

function observeFile(path: string, canonicalPath: string): string | undefined {
  let fd: number | undefined
  try {
    if (!samePath(realpathSync(path), canonicalPath)) return undefined
    fd = openSync(canonicalPath, 'r')
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > 64 * 1024 * 1024) return undefined
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, total)
      if (!count) break
      total += count
      if (total > before.size) return undefined
      hash.update(buffer.subarray(0, count))
    }
    const after = fstatSync(fd)
    const current = statSync(canonicalPath)
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || current.ino !== after.ino || current.dev !== after.dev || current.size !== after.size || current.ctimeMs !== after.ctimeMs
      || !samePath(realpathSync(path), canonicalPath)) return undefined
    return hash.digest('hex')
  } catch { return undefined } finally { if (fd !== undefined) closeSync(fd) }
}

function observeOperation(operation: RunOperation): OperationSettlement {
  const pending = (reason: string): OperationSettlement => ({ status: 'needs_recovery', effects: 'unknown', reason })
  if (operation.readOnly) return { status: 'completed', effects: 'read_only', reason: 'Read-only operation reconciled; a fresh read may be requested separately' }
  const evidence = operation.fileEvidence
  if (!evidence) return pending('External or untrusted mutation has no builtin file evidence; automatic replay is forbidden')
  const final = operation.fileObservations?.filter(observation => observation.final && samePath(observation.canonicalPath, evidence.canonicalPath)).at(-1)
  if (evidence.completion === 'format-pending' && !final) return pending('File write may have occurred, but final formatter evidence is absent; replay is forbidden')
  if (evidence.beforeHash === evidence.expectedHash && !final) return pending('Matching before and expected hashes cannot prove execution or exclude ABA; replay is forbidden')
  const observedHash = observeFile(evidence.path, evidence.canonicalPath)
  if (!observedHash) return pending('Current builtin file target is absent, changed, unreadable, or exceeds the inspection limit; replay is forbidden')
  const expected = final?.hash ?? evidence.expectedHash
  if (observedHash !== expected) return pending('Current artifact does not match the expected final file hash; a before hash is not proof of non-execution and replay is forbidden')
  return { status: 'completed', effects: 'observed_applied', observedHash, reason: 'Current builtin file artifact matches trusted expected evidence; observed only, without replay or a claim about causation' }
}

export async function reconcileOperation(path: string, operationId: string, options: OperationRecoveryOptions): Promise<{ status: 'completed' | 'cancelled' | 'needs_recovery'; receiptId: string }> {
  const receipt = await RunStore.appendReconciliation(path, operationId, options, operation => {
    if (options.decision === 'keep') return { status: 'needs_recovery', effects: 'unknown', reason: 'Operation remains pending; no replay or rollback was performed' }
    if (options.decision === 'cancel') return { status: 'cancelled', effects: operation.receipt?.effects ?? 'unknown', reason: 'Recovery obligation cancelled by explicit decision; no replay or rollback was performed' }
    return observeOperation(operation)
  })
  return { status: receipt.status, receiptId: receipt.receiptId }
}
