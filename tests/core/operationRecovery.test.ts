import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { createServer, request } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleKind, transpileModule } from 'typescript'
import { RunStore } from '../../src/core/runStore.js'
import { handleRuntimeCommand, inspectRuntime } from '../../src/core/runtimeRecovery.js'
import { digestOperationInput, reconcileOperation } from '../../src/core/operationRecovery.js'
import { acquireWorkspaceLease, readWorkspaceLease, reconcileWorkspace } from '../../src/core/workspaceLease.js'

const directories: string[] = []
const children: ChildProcess[] = []
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'ovo-operation-recovery-'))
  directories.push(root)
  return root
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve())
    child.once('error', reject)
    child.kill('SIGKILL')
  })
}
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(children.splice(0).map(kill))
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('reports the exact explicit unknown operation alongside absent receipts', async () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'unknown-run', workspace: root })
  const absent = run.intent('Write', false)
  const unknown = run.intent('Bash', false)
  run.receipt(unknown, 'unknown')
  const status = await inspectRuntime(root, root)
  expect(status.runs).toEqual([expect.objectContaining({
    pendingOperations: [
      expect.objectContaining({ operationId: absent, name: 'Write', receiptStatus: 'absent', replay: 'forbidden' }),
      expect.objectContaining({ operationId: unknown, name: 'Bash', receiptStatus: 'unknown', replay: 'forbidden' }),
    ],
  })])
})

it('persists a bounded digest and affected resources without raw approved arguments', () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'intent-run', workspace: root })
  const operation = run.intent('Write', false, {
    inputDigest: hash('approved-final-arguments'), workspace: root,
    affectedPaths: [join(root, 'file.txt')], resourceIds: ['process-42'],
  })
  expect(RunStore.inspect(run.path).operations[operation]).toMatchObject({
    inputDigest: hash('approved-final-arguments'), workspace: root,
    affectedPaths: [join(root, 'file.txt')], resourceIds: ['process-42'],
    summary: expect.stringContaining('Write'),
  })
})

it('rejects malformed extra operation metadata without rewriting the original record', () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'malformed-run', workspace: root })
  const operation = run.intent('Write', false)
  const raw = JSON.parse(readFileSync(run.path, 'utf8'))
  raw.operations[operation].inputDigest = 'not-a-digest'
  raw.operations[operation].affectedPaths = ['safe', 42]
  const invalid = JSON.stringify(raw)
  writeFileSync(run.path, invalid)
  expect(() => RunStore.inspect(run.path)).toThrow(/corrupt|invalid|unsupported/i)
  expect(readFileSync(run.path, 'utf8')).toBe(invalid)
})

it('keeps failed execution with unknown effects pending for reconciliation', () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'failed-effects', workspace: root })
  const operation = run.intent('Write', false)
  run.receipt(operation, 'failed', 'unknown')
  run.finish('failed')
  expect(RunStore.inspect(run.path).status).toBe('needs_recovery')
})

function fileRun(before = 'before', expected = 'after', completion: 'write-only' | 'format-pending' = 'write-only') {
  const root = directory()
  const path = join(root, 'file.txt')
  writeFileSync(path, before)
  const run = new RunStore(root, { runId: 'file-run', workspace: root })
  const operation = run.intent('Write', false, { inputDigest: hash('approved'), workspace: root, affectedPaths: [path], resourceIds: [] })
  const canonicalPath = realpathSync(path)
  run.recordFileEvidence(operation, { kind: 'builtin-file', path, canonicalPath, beforeHash: hash(before), expectedHash: hash(expected), completion })
  return { root, path, run, operation, canonicalPath }
}

function abandon(run: RunStore): void {
  const record = JSON.parse(readFileSync(run.path, 'utf8'))
  record.owner.birthId = 'previous-process-incarnation'
  writeFileSync(run.path, JSON.stringify(record))
}

function reconcile(run: RunStore, operation: string, decision: 'keep' | 'cancel' | 'continue') {
  const record = RunStore.inspect(run.path)
  return reconcileOperation(run.path, operation, { expectedEpoch: record.epoch, expectedRevision: record.revision, decision, physicalStopConfirmed: true })
}

it('binds the digest to tool workspace and final effective input without retaining secrets', () => {
  const input = { file_path: 'file.txt', content: 'secret-token-123', nested: { z: 2, a: 1 } }
  const digest = digestOperationInput('Write', 'C:/workspace', input)
  expect(digest).toMatch(/^[a-f0-9]{64}$/)
  expect(digest).toBe(digestOperationInput('Write', 'C:/workspace', { nested: { a: 1, z: 2 }, content: 'secret-token-123', file_path: 'file.txt' }))
  expect(digest).not.toBe(digestOperationInput('Edit', 'C:/workspace', input))
  expect(digest).not.toBe(digestOperationInput('Write', 'C:/another', input))
  expect(digest).not.toBe(digestOperationInput('Write', 'C:/workspace', { ...input, content: 'changed-by-hook' }))
})

it('observes the expected builtin file after a missing receipt without replaying the write', async () => {
  const { run, operation, path } = fileRun()
  writeFileSync(path, 'after')
  abandon(run)
  const result = await reconcile(run, operation, 'continue')
  expect(result).toMatchObject({ status: 'completed', receiptId: expect.any(String) })
  const restarted = RunStore.inspect(run.path)
  expect(restarted.operations[operation].receipt).toBeUndefined()
  expect(restarted.operations[operation].reconciliations).toEqual([expect.objectContaining({ decision: 'continue', status: 'completed', effects: 'observed_applied', observedHash: hash('after') })])
  expect(restarted.status).not.toBe('needs_recovery')
  expect(readFileSync(path, 'utf8')).toBe('after')
})

it('appends recovery evidence while preserving an explicitly unknown original receipt', async () => {
  const { run, operation, path } = fileRun()
  writeFileSync(path, 'after')
  run.receipt(operation, 'unknown', 'unknown')
  const original = RunStore.inspect(run.path).operations[operation].receipt
  abandon(run)
  await reconcile(run, operation, 'keep')
  expect(RunStore.inspect(run.path).status).toBe('needs_recovery')
  await reconcile(run, operation, 'continue')
  const restarted = RunStore.inspect(run.path)
  expect(restarted.operations[operation].receipt).toEqual(original)
  expect(restarted.operations[operation].reconciliations?.map(entry => entry.decision)).toEqual(['keep', 'continue'])
  expect(() => run.receipt(operation, 'completed')).toThrow(/revision|ownership/i)
})

it('keeps the unchanged before hash unknown because it does not prove non-execution', async () => {
  const { run, operation, path } = fileRun()
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
  expect(RunStore.inspect(run.path).status).toBe('needs_recovery')
  expect(readFileSync(path, 'utf8')).toBe('before')
})

it('does not treat matching before and expected hashes as proof without a durable observation', async () => {
  const { run, operation } = fileRun('same', 'same')
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
})

it('requires final formatter evidence before continuing an Edit operation', async () => {
  const { run, operation, path, canonicalPath } = fileRun('before', 'unformatted', 'format-pending')
  writeFileSync(path, 'unformatted')
  run.recordFileObservation(operation, { canonicalPath, hash: hash('unformatted'), final: false })
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
  expect(readFileSync(path, 'utf8')).toBe('unformatted')
})

it('observes the final formatter artifact without rerunning the formatter', async () => {
  const { run, operation, path, canonicalPath } = fileRun('before', 'unformatted', 'format-pending')
  writeFileSync(path, 'formatted')
  run.recordFileObservation(operation, { canonicalPath, hash: hash('formatted'), final: true })
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'completed' })
  expect(readFileSync(path, 'utf8')).toBe('formatted')
})

it('never gives a plugin named Write builtin hash reconciliation based on its name', async () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'plugin-run', workspace: root })
  const path = join(root, 'effect.txt')
  const operation = run.intent('Write', false, { inputDigest: hash('plugin'), workspace: root, affectedPaths: [path], resourceIds: [] })
  writeFileSync(path, 'plugin-effect')
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
  expect(readFileSync(path, 'utf8')).toBe('plugin-effect')
})

it('records cancel as no replay and no rollback while preserving the actual side effect', async () => {
  const { run, operation, path } = fileRun()
  writeFileSync(path, 'after')
  run.receipt(operation, 'unknown', 'unknown')
  abandon(run)
  expect(await reconcile(run, operation, 'cancel')).toMatchObject({ status: 'cancelled' })
  const record = RunStore.inspect(run.path)
  expect(record.operations[operation].receipt?.status).toBe('unknown')
  expect(record.operations[operation].reconciliations?.at(-1)).toMatchObject({ effects: 'unknown', reason: expect.stringMatching(/rollback|replay/i) })
  expect(record.status).toBe('cancelled')
  expect(readFileSync(path, 'utf8')).toBe('after')
  await expect(reconcile(run, operation, 'continue')).rejects.toThrow(/settled/i)
})

it('refuses recovery of a live owner without changing any operation record', async () => {
  const { run, operation } = fileRun()
  const original = readFileSync(run.path, 'utf8')
  await expect(reconcile(run, operation, 'cancel')).rejects.toThrow(/alive|unverified/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
})

it('refuses stale epochs and revisions without replacing original receipts', async () => {
  const { run, operation } = fileRun()
  run.receipt(operation, 'unknown')
  abandon(run)
  const record = RunStore.inspect(run.path)
  const original = readFileSync(run.path, 'utf8')
  await expect(reconcileOperation(run.path, operation, { expectedEpoch: 'stale', expectedRevision: record.revision, physicalStopConfirmed: true, decision: 'cancel' })).rejects.toThrow(/epoch|revision/i)
  await expect(reconcileOperation(run.path, operation, { expectedEpoch: record.epoch, expectedRevision: record.revision - 1, physicalStopConfirmed: true, decision: 'cancel' })).rejects.toThrow(/epoch|revision/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
})

it('retains unknown effects when a recorded canonical file target no longer matches', async () => {
  const { run, operation, path } = fileRun()
  const record = JSON.parse(readFileSync(run.path, 'utf8'))
  const other = join(directory(), 'other.txt')
  writeFileSync(other, 'after')
  record.operations[operation].fileEvidence.canonicalPath = realpathSync(other)
  writeFileSync(run.path, JSON.stringify(record))
  writeFileSync(path, 'after')
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
  expect(readFileSync(other, 'utf8')).toBe('after')
})

it('preserves a later file edit instead of replaying a previously observed builtin write', async () => {
  const { run, operation, path, canonicalPath } = fileRun()
  writeFileSync(path, 'after')
  run.recordFileObservation(operation, { canonicalPath, hash: hash('after'), final: true })
  writeFileSync(path, 'later edit')
  abandon(run)
  expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
  expect(readFileSync(path, 'utf8')).toBe('later edit')
})

it('rejects changed durable ownership during reconciliation without overwriting the changed record', async () => {
  const { run, operation } = fileRun()
  run.receipt(operation, 'unknown', 'unknown')
  abandon(run)
  const record = RunStore.inspect(run.path)
  let replaced = ''
  await expect(RunStore.appendReconciliation(run.path, operation, { expectedEpoch: record.epoch, expectedRevision: record.revision, decision: 'cancel', physicalStopConfirmed: true }, () => {
    const current = JSON.parse(readFileSync(run.path, 'utf8'))
    current.owner.birthId = 'changed-during-recovery'
    replaced = JSON.stringify(current)
    writeFileSync(run.path, replaced)
    return { status: 'cancelled', effects: 'unknown', reason: 'explicit cancellation' }
  })).rejects.toThrow(/ownership|revision/i)
  expect(readFileSync(run.path, 'utf8')).toBe(replaced)
})

it('refuses recovery when physical termination has not been explicitly confirmed', async () => {
  const { run, operation } = fileRun()
  abandon(run)
  const record = RunStore.inspect(run.path)
  const original = readFileSync(run.path, 'utf8')
  await expect(reconcileOperation(run.path, operation, { expectedEpoch: record.epoch, expectedRevision: record.revision, decision: 'cancel', physicalStopConfirmed: false })).rejects.toThrow(/physical/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
})

it('discards unknown extra values instead of serializing raw arguments into intent metadata', () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'redaction-run', workspace: root })
  const metadata = { inputDigest: hash('secret-token-123'), workspace: root, affectedPaths: [], resourceIds: [], input: { password: 'secret-token-123' } }
  run.intent('external', false, metadata)
  expect(readFileSync(run.path, 'utf8')).not.toContain('secret-token-123')
})

it.each([
  { field: 'resourceIds', value: Array(129).fill('process-1') },
  { field: 'affectedPaths', value: ['x'.repeat(32769)] },
  { field: 'summary', value: 'x'.repeat(1025) },
])('rejects unbounded operation $field before committing an intent', ({ field, value }) => {
  const root = directory()
  const run = new RunStore(root, { runId: 'bounded-run', workspace: root })
  const original = readFileSync(run.path, 'utf8')
  const metadata = { inputDigest: hash('input'), workspace: root, affectedPaths: [], resourceIds: [], [field]: value }
  expect(() => run.intent('Write', false, metadata)).toThrow(/invalid/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
})

it.each([
  { receipt: { status: 'failed', effects: ['unknown'] } },
  { fileEvidence: { kind: 'builtin-file', path: 'file', canonicalPath: 'file', beforeHash: null, expectedHash: hash('after'), completion: ['write-only'] } },
  { fileObservations: [{ canonicalPath: 'file', hash: hash('after'), final: true }] },
  { reconciliations: [{ receiptId: 'receipt', decision: 'cancel', status: 'completed' }] },
])('fails closed for malformed added durable evidence %j', patch => {
  const { run, operation } = fileRun()
  const record = JSON.parse(readFileSync(run.path, 'utf8'))
  const replacement = structuredClone(patch)
  if (replacement.receipt) Object.assign(replacement.receipt, { recordedAt: new Date().toISOString() })
  Object.assign(record.operations[operation], replacement)
  const original = JSON.stringify(record)
  writeFileSync(run.path, original)
  expect(() => RunStore.inspect(run.path)).toThrow(/corrupt|invalid|unsupported/i)
  expect(readFileSync(run.path, 'utf8')).toBe(original)
})

it.each(['before-write', 'after-write', 'after-observation', 'unknown-receipt'])('recovers the exact operation after a real process is killed at %s', async stage => {
  const root = directory()
  const runtime = join(root, 'runtime')
  mkdirSync(runtime)
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  for (const name of ['runStore', 'runtimeState', 'persistenceLock', 'processIdentity', 'atomicWrite']) {
    writeFileSync(join(runtime, `${name}.js`), transpileModule(readFileSync(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
  }
  const child = fork(fileURLToPath(new URL('../fixtures/operationCrash.mjs', import.meta.url)), [runtime, root, stage], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  let diagnostic = ''
  child.stderr?.on('data', chunk => { diagnostic += String(chunk) })
  const barrier = await new Promise<{ path: string; operation: string; file: string }>((resolve, reject) => {
    child.once('message', message => resolve(message as { path: string; operation: string; file: string }))
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`Crash worker exited before barrier: ${diagnostic}`)))
  })
  await kill(child)
  const before = statSync(barrier.file)
  const record = RunStore.inspect(barrier.path)
  const inspected = await inspectRuntime(root, join(root, 'state'))
  expect(inspected.runs).toEqual([expect.objectContaining({ pendingOperations: [expect.objectContaining({ operationId: barrier.operation, name: 'Write', affectedPaths: [barrier.file], replay: 'forbidden' })] })])
  const result = await reconcileOperation(barrier.path, barrier.operation, { expectedEpoch: record.epoch, expectedRevision: record.revision, decision: 'continue', physicalStopConfirmed: true })
  expect(result.status).toBe(stage === 'before-write' ? 'needs_recovery' : 'completed')
  expect(readFileSync(barrier.file, 'utf8')).toBe(stage === 'before-write' ? 'before' : 'after')
  expect(statSync(barrier.file).ino).toBe(before.ino)
  expect(statSync(barrier.file).mtimeMs).toBe(before.mtimeMs)
  if (stage === 'unknown-receipt') expect(RunStore.inspect(barrier.path).operations[barrier.operation].receipt?.status).toBe('unknown')
})

it('does not repeat an externally accepted action after disconnect through keep continue or cancel', async () => {
  const root = directory()
  const run = new RunStore(root, { runId: 'external-run', workspace: root })
  let accepted = 0
  const server = createServer((incoming, response) => {
    incoming.resume()
    incoming.once('end', () => { accepted++; response.destroy() })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Local HTTP test server is unavailable')
    const operation = run.intent('external-post', false, { inputDigest: hash('accepted-action'), workspace: root, affectedPaths: [], resourceIds: ['http-request-1'] })
    await expect(new Promise<void>((resolve, reject) => {
      const outgoing = request(`http://127.0.0.1:${address.port}/accept`, { method: 'POST' }, response => { response.resume(); response.once('end', resolve) })
      outgoing.once('error', reject)
      outgoing.end('accepted once')
    })).rejects.toThrow()
    run.receipt(operation, 'unknown', 'unknown')
    abandon(run)
    expect(await reconcile(run, operation, 'keep')).toMatchObject({ status: 'needs_recovery' })
    expect(await reconcile(run, operation, 'continue')).toMatchObject({ status: 'needs_recovery' })
    expect(await reconcile(run, operation, 'cancel')).toMatchObject({ status: 'cancelled' })
    expect(accepted).toBe(1)
    expect(RunStore.inspect(run.path).operations[operation].receipt?.status).toBe('unknown')
  } finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

async function abandonedWorkspace(root: string): Promise<string> {
  const lease = await acquireWorkspaceLease(root, { stateRoot: root })
  lease.quarantine()
  const path = join(root, 'workspaces', readdirSync(join(root, 'workspaces')).find(name => name.endsWith('.json'))!)
  const record = JSON.parse(readFileSync(path, 'utf8'))
  record.owner.birthId = 'previous-workspace-incarnation'
  writeFileSync(path, JSON.stringify(record))
  return lease.epoch
}

it('reports a workspace as unavailable while a retained operation is unknown without any lease', async () => {
  const { root, run, operation } = fileRun()
  run.receipt(operation, 'unknown', 'unknown')
  expect(await inspectRuntime(root, root)).toMatchObject({ accepting: false })
})

it('reports the same exact pending operations through a canonical workspace alias and Windows casing', async () => {
  const { root, run, operation } = fileRun()
  run.receipt(operation, 'unknown', 'unknown')
  const alias = join(directory(), 'workspace-alias')
  symlinkSync(root, alias, 'junction')
  const inspected = await inspectRuntime(process.platform === 'win32' ? alias.toUpperCase() : alias, root)
  expect(inspected).toMatchObject({ accepting: false, runs: [expect.objectContaining({ pendingOperations: [expect.objectContaining({ operationId: operation })] })] })
})

function unrelatedRuntimeHistory(): { root: string; matching: RunStore; operation: string } {
  const root = directory()
  const unrelated = directory()
  const matching = new RunStore(root, { runId: '000-matching', workspace: root })
  const operation = matching.intent('external-post', false)
  matching.receipt(operation, 'unknown', 'unknown')
  const base = new RunStore(root, { runId: 'unrelated-source', workspace: unrelated })
  base.finish('completed')
  const record = JSON.parse(readFileSync(base.path, 'utf8'))
  for (let index = 0; index < 1001; index++) {
    const runId = `zzz-unrelated-${index}`
    writeFileSync(join(root, 'runs', runId + '.json'), JSON.stringify({ ...record, runId }))
  }
  return { root, matching, operation }
}

it('shows an older exact matching unknown operation despite 1001 unrelated newer records', async () => {
  const { root, operation } = unrelatedRuntimeHistory()
  const inspected = await inspectRuntime(root, root)
  expect(inspected).toMatchObject({ accepting: false, runs: [expect.objectContaining({ runId: '000-matching', pendingOperations: [expect.objectContaining({ operationId: operation })] })], matchedRunCount: 1, pendingOperationCount: 1, omittedRunCount: 0 })
})

it('does not mark an empty workspace unavailable because unrelated histories exceed the display limit', async () => {
  const { root } = unrelatedRuntimeHistory()
  expect(await inspectRuntime(directory(), root)).toMatchObject({ accepting: true, runs: [], matchedRunCount: 0, pendingOperationCount: 0, truncated: false })
})

it('counts all matching pending runs and permits exact targeted inspection beyond the display limit', async () => {
  const root = directory()
  const seed = new RunStore(root, { runId: '000-seed', workspace: root })
  const operation = seed.intent('external-post', false)
  seed.receipt(operation, 'unknown', 'unknown')
  const record = JSON.parse(readFileSync(seed.path, 'utf8'))
  for (let index = 0; index < 1000; index++) {
    const runId = `pending-${String(index).padStart(4, '0')}`
    writeFileSync(join(root, 'runs', runId + '.json'), JSON.stringify({ ...record, runId }))
  }
  const selected = 'zzzz-last-pending'
  writeFileSync(join(root, 'runs', selected + '.json'), JSON.stringify({ ...record, runId: selected }))
  const aggregate = await inspectRuntime(root, root)
  expect(aggregate).toMatchObject({ accepting: false, matchedRunCount: 1002, pendingOperationCount: 1002, omittedRunCount: 2, omittedPendingOperationCount: 2, truncated: true })
  expect(aggregate.runs).toHaveLength(1000)
  expect((aggregate.runs as Array<{ runId: string }>).some(run => run.runId === selected)).toBe(false)
  const targeted = await inspectRuntime(root, root, { runId: selected, operationId: operation })
  expect(targeted).toMatchObject({ accepting: false, matchedRunCount: 1002, pendingOperationCount: 1002, runs: [expect.objectContaining({ runId: selected, pendingOperations: [expect.objectContaining({ operationId: operation })] })] })
  vi.stubEnv('OVOGO_STATE_DIR', root)
  let output = ''
  await handleRuntimeCommand(['--runtime-status', root, '--run-id', selected, '--operation-id', operation], text => { output += text })
  expect(JSON.parse(output)).toMatchObject({ filter: { runId: selected, operationId: operation }, runs: [expect.objectContaining({ runId: selected, pendingOperations: [expect.objectContaining({ operationId: operation })] })] })
})

it.each(['cancel', 'continue'] as const)('does not release an unknown operation through physical-stop workspace %s', async decision => {
  const { root, run, operation } = fileRun()
  const epoch = await abandonedWorkspace(root)
  run.receipt(operation, 'unknown', 'unknown')
  abandon(run)
  await expect(reconcileWorkspace(root, { stateRoot: root, expectedEpoch: epoch, decision, physicalStopConfirmed: true, artifactVersion: 'current' })).rejects.toThrow(operation)
  expect(readWorkspaceLease(root, root)).toMatchObject({ state: 'needs_recovery', epoch })
  expect(RunStore.inspect(run.path).operations[operation].receipt?.status).toBe('unknown')
})

it('permits workspace release only after a separate explicit operation cancellation', async () => {
  const { root, run, operation, path } = fileRun()
  const epoch = await abandonedWorkspace(root)
  writeFileSync(path, 'after')
  run.receipt(operation, 'unknown', 'unknown')
  abandon(run)
  await reconcile(run, operation, 'cancel')
  await reconcileWorkspace(root, { stateRoot: root, expectedEpoch: epoch, decision: 'cancel', physicalStopConfirmed: true, artifactVersion: 'current' })
  expect(readWorkspaceLease(root, root)?.state).toBe('released')
  expect(readFileSync(path, 'utf8')).toBe('after')
})

it('blocks a new workspace mutation while a previous finished run has unknown effects', async () => {
  const { root, run, operation } = fileRun()
  run.receipt(operation, 'failed', 'unknown')
  run.finish('failed')
  await expect(acquireWorkspaceLease(root, { stateRoot: root })).rejects.toThrow(operation)
  expect(readWorkspaceLease(root, root)).toBeUndefined()
})

it('allows a live running missing intent to enter its normal workspace lease', async () => {
  const { root } = fileRun()
  const lease = await acquireWorkspaceLease(root, { stateRoot: root })
  lease.release()
  expect(readWorkspaceLease(root, root)?.state).toBe('released')
})

it('rereads a changed run after a prior successful workspace inspection', async () => {
  const { root, run, operation } = fileRun()
  run.receipt(operation, 'completed', 'observed_applied')
  const first = await acquireWorkspaceLease(root, { stateRoot: root })
  first.release()
  const later = run.intent('external', false)
  run.receipt(later, 'unknown', 'unknown')
  await expect(acquireWorkspaceLease(root, { stateRoot: root })).rejects.toThrow(later)
})

it('requires the CLI to reconcile each exact operation before releasing its workspace', async () => {
  const { root, run, operation } = fileRun()
  const epoch = await abandonedWorkspace(root)
  run.receipt(operation, 'unknown', 'unknown')
  abandon(run)
  vi.stubEnv('OVOGO_STATE_DIR', root)
  await expect(handleRuntimeCommand(['--recover-workspace', root, '--epoch', epoch, '--decision', 'cancel', '--confirm-physical-stop'], () => {})).rejects.toThrow(operation)
  const record = RunStore.inspect(run.path)
  let output = ''
  expect(await handleRuntimeCommand(['--recover-operation', record.runId, '--operation-id', operation, '--epoch', record.epoch, '--revision', String(record.revision), '--decision', 'cancel', '--confirm-physical-stop'], text => { output += text })).toBe(true)
  expect(JSON.parse(output)).toMatchObject({ reconciliation: { operationId: operation, status: 'cancelled', receiptId: expect.any(String) } })
  await handleRuntimeCommand(['--recover-workspace', root, '--epoch', epoch, '--decision', 'cancel', '--confirm-physical-stop'], () => {})
  expect(readWorkspaceLease(root, root)?.state).toBe('released')
})
