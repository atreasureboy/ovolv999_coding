import { existsSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { RunStore } from './runStore.js'
import { runtimeStateRoot } from './runtimeState.js'
import { inspectProcessIdentity } from './processIdentity.js'
import { readWorkspaceLease, reconcileWorkspace } from './workspaceLease.js'
import { captureArtifactVersion } from './verification.js'

export async function inspectRuntime(cwd: string, root = runtimeStateRoot()): Promise<Record<string, unknown>> {
  const workspace = resolve(cwd)
  const lease = readWorkspaceLease(workspace, root)
  const runsPath = join(root, 'runs')
  const runs: Array<Record<string, unknown>> = []
  if (existsSync(runsPath)) {
    const names = readdirSync(runsPath).filter(name => name.endsWith('.json')).slice(-1000)
    for (const name of names) {
      try {
        const record = RunStore.inspect(join(runsPath, name))
        if (resolve(record.workspace) !== workspace) continue
        runs.push({ runId: record.runId, parentRunId: record.parentRunId, status: record.status, revision: record.revision, pendingOperations: Object.entries(record.operations).filter(([, operation]) => !operation.receipt).map(([operationId, operation]) => ({ operationId, name: operation.name, replay: operation.readOnly ? 'read may be repeated after reconciliation' : 'forbidden without external reconciliation' })) })
      } catch { runs.push({ record: name, status: 'corrupt', recovery: 'preserve and inspect the record' }) }
    }
  }
  const ownerStatus = lease ? await inspectProcessIdentity(lease.owner) : undefined
  return { schemaVersion: 1, workspace, stateRoot: root, accepting: !lease || lease.state === 'released', lease, ownerStatus, runs, truncatedAt: 1000 }
}

export async function handleRuntimeCommand(args: readonly string[], write: (text: string) => void = text => { process.stdout.write(text) }): Promise<boolean> {
  const status = args.indexOf('--runtime-status')
  const recover = args.indexOf('--recover-workspace')
  if (status < 0 && recover < 0) return false
  const index = recover >= 0 ? recover : status
  const value = args[index + 1]
  if (recover >= 0 && (!value || value.startsWith('--'))) throw new Error('--recover-workspace requires a workspace path')
  const cwd = value && !value.startsWith('--') ? resolve(value) : process.cwd()
  if (recover >= 0) {
    const option = (name: string): string | undefined => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1] }
    const expectedEpoch = option('--epoch')
    const decision = option('--decision')
    if (!expectedEpoch || !['keep', 'cancel', 'continue'].includes(decision ?? '')) throw new Error('Recovery requires --epoch and --decision keep|cancel|continue')
    if (!args.includes('--confirm-physical-stop')) throw new Error('Confirm that all physical operations and descendants stopped with --confirm-physical-stop')
    const artifactVersion = await captureArtifactVersion(cwd)
    await reconcileWorkspace(cwd, { expectedEpoch, decision: decision as 'keep' | 'cancel' | 'continue', physicalStopConfirmed: true, artifactVersion })
  }
  write(JSON.stringify(await inspectRuntime(cwd), null, 2) + '\n')
  return true
}
