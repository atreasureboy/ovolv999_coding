import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LoopAttemptStore } from '../../../src/core/autonomy/attemptStore.js'
import type { LoopCheckpoint, LoopEvidence, LoopTerminal } from '../../../src/core/autonomy/types.js'

const roots: string[] = []
const stores: LoopAttemptStore[] = []
const children: ChildProcess[] = []
const fixture = fileURLToPath(new URL('../../fixtures/loopAttemptCrash.mjs', import.meta.url))

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'loop-attempt-'))
  roots.push(root)
  return { sessionDir: root, mode: 'create' as 'create' | 'resume', identity: { workspace: root, sessionId: 'session-1', goalHash: 'goal-1', definitionHash: 'definition-1' }, maxIterations: 2, stagnationLimit: 3 }
}

async function open(options: ReturnType<typeof setup>) {
  const store = await LoopAttemptStore.open(options)
  stores.push(store)
  return store
}

const terminal: LoopTerminal = { threadId: 'thread-1', turnId: 'turn-1', finishedSequence: 5, historyRevision: 2, status: 'completed', reason: 'stop_sequence', unfinishedResources: [] }

function settled(store: LoopAttemptStore) {
  let state = store.prepare(store.snapshot().revision)
  state = store.dispatch(state.current!.id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })
  return store.settle(state.current!.id, state.revision, terminal)
}

function evidence(root: string): LoopEvidence {
  return { status: 'failed', workspace: root, definitionHash: 'definition-1', artifactVersion: 'artifact-1', commands: [{ command: 'check', passed: false, output: 'failed', exitCode: 1 }], output: 'failed', failureFingerprint: 'failure-1', truncated: false }
}

function checkpoint(store: LoopAttemptStore, root: string, completed = false): LoopCheckpoint {
  const value = evidence(root)
  if (completed) { value.status = 'passed'; value.sufficientForCompletion = true; value.commands = [{ command: 'check', passed: true, output: 'passed', exitCode: 0 }] }
  return { artifactVersion: 'artifact-1', evidence: store.writeEvidence(store.snapshot().current!.id, value), verificationSource: 'loop', stagnation: { count: 1, fingerprint: 'failure-1', artifactVersion: 'artifact-1' }, decision: completed ? { action: 'stop', status: 'completed', detail: 'passed' } : { action: 'continue' }, ...(completed ? { acceptedAt: new Date().toISOString() } : {}) }
}

async function childAt(root: string, mode: string) {
  const child = fork(fixture, [root, mode], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  let diagnostics = ''
  child.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Child timeout: ${diagnostics}`)), 30000)
    child.once('message', () => { clearTimeout(timer); resolve() })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Child exit ${code}: ${diagnostics}`)) })
    child.once('error', reject)
  })
  return child
}

async function kill(child: ChildProcess) {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) await kill(child)
  for (const store of stores.splice(0)) { try { store.close() } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it.each(['prepared', 'settled', 'after-prepare-rename'])('reserves one iteration and never refunds a real child killed after %s', async phase => {
  const options = setup()
  await kill(await childAt(options.sessionDir, phase))
  const store = await open({ ...options, mode: 'resume' })
  expect(store.snapshot().consumedIterations).toBe(1)
  expect(store.snapshot().current?.phase).toBe(phase === 'after-prepare-rename' ? 'prepared' : phase)
  expect(() => store.prepare(store.snapshot().revision)).toThrow()
}, 45000)

it('preserves the last authoritative state when publication is interrupted after the archival snapshot', async () => {
  const options = setup()
  await kill(await childAt(options.sessionDir, 'before-checkpoint-rename'))
  const store = await open({ ...options, mode: 'resume' })
  expect(store.snapshot()).toMatchObject({ revision: 3, consumedIterations: 1, current: { phase: 'settled' } })
  expect(readdirSync(join(options.sessionDir, 'loop-controller', 'attempts')).length).toBe(1)
  expect(() => store.prepare(3)).toThrow()
}, 45000)

it('rejects a second real writer without stealing ownership', async () => {
  const options = setup()
  const child = await childAt(options.sessionDir, 'prepared')
  const before = readFileSync(join(options.sessionDir, 'loop-controller', 'state.json'), 'utf8')
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
  expect(readFileSync(join(options.sessionDir, 'loop-controller', 'state.json'), 'utf8')).toBe(before)
  await kill(child)
}, 45000)

it('rejects stale revisions and a writer that lost its lease before publication', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  expect(() => store.prepare(0)).toThrow()
  const value = checkpoint(store, options.sessionDir)
  const statePath = join(options.sessionDir, 'loop-controller', 'state.json')
  const before = readFileSync(statePath, 'utf8')
  const directory = join(options.sessionDir, 'loop-controller', 'writer.lock.owners')
  expect(() => store.checkpoint(state.current!.id, state.revision, value, () => {
    if (readdirSync(join(options.sessionDir, 'loop-controller')).some(name => name.startsWith('state.json.tmp-'))) writeFileSync(join(directory, readdirSync(directory)[0], 'ticket'), '99999')
  })).toThrow()
  expect(readFileSync(statePath, 'utf8')).toBe(before)
})

it('compares authoritative contents as well as revision and returns detached snapshots', async () => {
  const options = setup()
  const store = await open(options)
  const snapshot = store.snapshot()
  snapshot.maxIterations = 500
  expect(store.snapshot().maxIterations).toBe(2)
  const path = join(options.sessionDir, 'loop-controller', 'state.json')
  const changed = { ...store.snapshot(), maxIterations: 500 }
  writeFileSync(path, JSON.stringify(changed))
  expect(() => store.prepare(0)).toThrow()
  expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(changed)
})

it.each(['goalHash', 'definitionHash', 'sessionId', 'workspace'] as const)('rejects changed %s identities without modifying the ledger', async key => {
  const options = setup()
  const store = await open(options)
  store.close()
  const changed = { ...options.identity, [key]: key === 'workspace' ? tmpdir() : 'changed' }
  await expect(open({ ...options, mode: 'resume', identity: changed })).rejects.toMatchObject({ outcomeReason: { code: key === 'goalHash' || key === 'definitionHash' ? 'acceptance_invalidated' : 'recovery_required' } })
  await expect(open({ ...options, mode: 'resume', identity: changed })).rejects.toMatchObject({ taskId: store.snapshot().taskId, consumedIterations: 0 })
})

it('keeps stored limits, stagnation and previous checkpoint without completing a pending attempt', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir)
  store.checkpoint(state.current!.id, state.revision, value, () => {})
  store.close()
  const resumed = await open({ ...options, mode: 'resume', maxIterations: 20, stagnationLimit: 30 })
  expect(resumed.snapshot()).toMatchObject({ maxIterations: 2, stagnationLimit: 3, stagnation: { count: 1 } })
  const next = resumed.prepare(resumed.snapshot().revision)
  expect(next).toMatchObject({ consumedIterations: 2, previousCheckpoint: value, current: { phase: 'prepared' } })
  expect(next.current!.checkpoint).toBeUndefined()
  expect(() => resumed.prepare(next.revision)).toThrow()
})

it('rejects skipped transitions and conflicting events while duplicate events do not consume iterations', async () => {
  const store = await open(setup())
  let state = store.prepare(0)
  const id = state.current!.id
  expect(() => store.settle(id, state.revision, terminal)).toThrow()
  state = store.dispatch(id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })
  expect(store.dispatch(id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })).toEqual(state)
  expect(() => store.dispatch(id, state.revision, { threadId: 'thread-1', turnId: 'other' })).toThrow()
  state = store.settle(id, state.revision, terminal)
  expect(store.settle(id, state.revision, terminal)).toEqual(state)
  expect(() => store.settle(id, state.revision, { ...terminal, status: 'failed' })).toThrow()
  expect(state.consumedIterations).toBe(1)
})

it('refuses prepare after a terminal decision or exhaustion and revalidates success without consuming iterations', async () => {
  const options = { ...setup(), maxIterations: 1 }
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir, true)
  const done = store.checkpoint(state.current!.id, state.revision, value, () => {})
  expect(() => store.prepare(done.revision)).toThrow()
  const updated = store.revalidate(done.revision, value, () => {})
  expect(updated.consumedIterations).toBe(1)
  expect(() => store.prepare(updated.revision)).toThrow()
})

it('enforces exhaustion even when the checkpoint would otherwise continue', async () => {
  const options = { ...setup(), maxIterations: 1 }
  const store = await open(options)
  const state = settled(store)
  const done = store.checkpoint(state.current!.id, state.revision, checkpoint(store, options.sessionDir), () => {})
  expect(() => store.prepare(done.revision)).toThrow()
  expect(() => store.revalidate(done.revision, done.current!.checkpoint!, () => {})).toThrow()
  expect(store.snapshot().consumedIterations).toBe(1)
})

it('preserves unknown owner data and refuses to steal its writer lease', async () => {
  const options = setup()
  const store = await open(options)
  store.close()
  const path = join(options.sessionDir, 'loop-controller', 'writer.lock.owners', 'unknown-owner')
  mkdirSync(path)
  writeFileSync(join(path, 'ticket'), '1')
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
  expect(readFileSync(join(path, 'ticket'), 'utf8')).toBe('1')
})

it('rejects a forged success and corruption of referenced evidence on resume', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir)
  expect(() => store.checkpoint(state.current!.id, state.revision, { ...value, decision: { action: 'stop', status: 'completed', detail: 'forged' }, acceptedAt: new Date().toISOString() }, () => {})).toThrow()
  store.checkpoint(state.current!.id, state.revision, value, () => {})
  store.close()
  writeFileSync(join(options.sessionDir, 'loop-controller', value.evidence.path), '{}')
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
})

it.each([1, null])('rejects a passed command with exit code %s during checkpoint and revalidation without changing state', async exitCode => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const valid = checkpoint(store, options.sessionDir, true)
  const evidence = store.readEvidence(valid.evidence)
  evidence.commands[0].exitCode = exitCode
  const invalid = { ...valid, evidence: store.writeEvidence(state.current!.id, evidence) }
  const path = join(options.sessionDir, 'loop-controller', 'state.json')
  const beforeCheckpoint = readFileSync(path, 'utf8')
  expect(() => store.checkpoint(state.current!.id, state.revision, invalid, () => {})).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(beforeCheckpoint)
  expect(store.snapshot()).toEqual(state)
  const completed = store.checkpoint(state.current!.id, state.revision, valid, () => {})
  const beforeRevalidation = readFileSync(path, 'utf8')
  expect(() => store.revalidate(completed.revision, invalid, () => {})).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(beforeRevalidation)
  expect(store.snapshot()).toEqual(completed)
})

it.each([1, null])('rejects a durable completed receipt with command exit code %s on resume and preserves it', async exitCode => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir, true)
  const completed = store.checkpoint(state.current!.id, state.revision, value, () => {})
  const evidence = store.readEvidence(value.evidence)
  evidence.commands[0].exitCode = exitCode
  completed.current!.checkpoint!.evidence = store.writeEvidence(state.current!.id, evidence)
  store.close()
  const path = join(options.sessionDir, 'loop-controller', 'state.json')
  const corrupted = JSON.stringify(completed)
  writeFileSync(path, corrupted)
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
  expect(readFileSync(path, 'utf8')).toBe(corrupted)
})

it('rejects forged command-free success during checkpoint, revalidation and resume', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir, true)
  const evidence = store.readEvidence(value.evidence)
  evidence.commands = []
  const invalid = { ...value, evidence: store.writeEvidence(state.current!.id, evidence) }
  const path = join(options.sessionDir, 'loop-controller', 'state.json')
  const before = readFileSync(path, 'utf8')
  expect(() => store.checkpoint(state.current!.id, state.revision, invalid, () => {})).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(before)
  const completed = store.checkpoint(state.current!.id, state.revision, value, () => {})
  const beforeRevalidation = readFileSync(path, 'utf8')
  expect(() => store.revalidate(completed.revision, invalid, () => {})).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(beforeRevalidation)
  store.close()
  completed.current!.checkpoint = invalid
  const corrupted = JSON.stringify(completed)
  writeFileSync(path, corrupted)
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
  expect(readFileSync(path, 'utf8')).toBe(corrupted)
})

it('retains command-free evidence for non-completed outcomes', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir)
  const evidence = store.readEvidence(value.evidence)
  evidence.status = 'not_applicable'
  evidence.commands = []
  value.evidence = store.writeEvidence(state.current!.id, evidence)
  store.checkpoint(state.current!.id, state.revision, value, () => {})
  store.close()
  const resumed = await open({ ...options, mode: 'resume' })
  expect(resumed.snapshot().current?.checkpoint?.decision).toEqual({ action: 'continue' })
  expect(resumed.readEvidence(value.evidence).commands).toEqual([])
})

it('rejects an oversized terminal without overwriting the dispatched state', async () => {
  const options = setup()
  const store = await open(options)
  let state = store.prepare(0)
  state = store.dispatch(state.current!.id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })
  expect(() => store.settle(state.current!.id, state.revision, { ...terminal, unfinishedResources: Array.from({ length: 100 }, () => '中'.repeat(1000)) })).toThrow()
  expect(store.snapshot()).toEqual(state)
})

it('allows omitted optional fields represented as undefined without drifting from durable state', async () => {
  const store = await open(setup())
  let state = store.prepare(0)
  state = store.dispatch(state.current!.id, state.revision, { threadId: 'thread-1', turnId: 'turn-1' })
  state = store.settle(state.current!.id, state.revision, { ...terminal, outcomeReason: undefined })
  expect(store.settle(state.current!.id, state.revision, terminal)).toEqual(state)
})

it('requires workspace ownership and evidence bound to the checkpoint artifact and definition', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir)
  expect(() => store.checkpoint(state.current!.id, state.revision, value, () => { throw new Error('lost workspace') })).toThrow()
  expect(() => store.checkpoint(state.current!.id, state.revision, { ...value, artifactVersion: 'different' }, () => {})).toThrow()
  expect(store.snapshot()).toEqual(state)
})

it('rejects evidence changed after staging but before authoritative publication', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const value = checkpoint(store, options.sessionDir, true)
  const root = join(options.sessionDir, 'loop-controller')
  const before = readFileSync(join(root, 'state.json'), 'utf8')
  expect(() => store.checkpoint(state.current!.id, state.revision, value, () => {
    if (readdirSync(root).some(name => name.startsWith('state.json.tmp-'))) writeFileSync(join(root, value.evidence.path), '{}')
  })).toThrow()
  expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe(before)
})

it('writes immutable bounded whitelisted evidence and detects corruption', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const input = { ...evidence(options.sessionDir), providerContinuation: 'secret', commands: [{ ...evidence(options.sessionDir).commands[0], reasoning: 'secret' }] }
  const first = store.writeEvidence(state.current!.id, input)
  const second = store.writeEvidence(state.current!.id, input)
  expect(first.path).not.toBe(second.path)
  expect(store.readEvidence(first)).toEqual(evidence(options.sessionDir))
  expect(() => store.writeEvidence(state.current!.id, { ...input, output: '中'.repeat(100000) })).toThrow()
  writeFileSync(join(options.sessionDir, 'loop-controller', first.path), '{}')
  expect(() => store.readEvidence(first)).toThrow()
})

it('rejects traversal, symlink, hardlink and oversized evidence files', async () => {
  const options = setup()
  const store = await open(options)
  const state = settled(store)
  const ref = store.writeEvidence(state.current!.id, evidence(options.sessionDir))
  expect(() => store.readEvidence({ ...ref, path: '../state.json' })).toThrow()
  const path = join(options.sessionDir, 'loop-controller', ref.path)
  const linked = join(options.sessionDir, 'evidence-copy')
  linkSync(path, linked)
  expect(() => store.readEvidence(ref)).toThrow()
  rmSync(linked)
  rmSync(path)
  writeFileSync(linked, JSON.stringify(evidence(options.sessionDir)))
  symlinkSync(process.platform === 'win32' ? options.sessionDir : linked, path, process.platform === 'win32' ? 'junction' : 'file')
  expect(() => store.readEvidence(ref)).toThrow()
  rmSync(path, { recursive: process.platform === 'win32' })
  const bytes = Buffer.alloc(256 * 1024 + 1, ' ')
  writeFileSync(path, bytes)
  expect(() => store.readEvidence({ ...ref, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })).toThrow()
})

it.each(['schema', 'json', 'oversize', 'invalid-phase'])('preserves corrupt %s state rather than recovering from an orphan', async fault => {
  const options = setup()
  const store = await open(options)
  const state = store.prepare(0)
  store.close()
  const path = join(options.sessionDir, 'loop-controller', 'state.json')
  const bytes = fault === 'schema' ? JSON.stringify({ ...state, schemaVersion: 2 }) : fault === 'invalid-phase' ? JSON.stringify({ ...state, current: { ...state.current, phase: 'checkpointed' } }) : fault === 'json' ? '{' : ' '.repeat(256 * 1024 + 1)
  writeFileSync(path, bytes)
  await expect(open({ ...options, mode: 'resume' })).rejects.toMatchObject({ outcomeReason: { code: 'recovery_required', scope: 'session' } })
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})

it('never overwrites existing state in create mode or creates missing state in resume mode', async () => {
  const options = setup()
  await expect(open({ ...options, mode: 'resume' })).rejects.toThrow()
  expect(existsSync(join(options.sessionDir, 'loop-controller', 'state.json'))).toBe(false)
  const store = await open(options)
  store.prepare(0)
  store.close()
  await expect(open(options)).rejects.toThrow()
})

it('canonicalizes workspace junctions and Windows case while refusing linked controller directories', async () => {
  const options = setup()
  const alias = join(options.sessionDir, 'workspace-alias')
  const workspace = join(options.sessionDir, 'workspace')
  mkdirSync(workspace)
  symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const store = await open({ ...options, identity: { ...options.identity, workspace } })
  store.close()
  const resumed = await open({ ...options, mode: 'resume', identity: { ...options.identity, workspace: process.platform === 'win32' ? alias.toUpperCase() : alias } })
  expect(resumed.snapshot().workspace).toBe(process.platform === 'win32' ? workspace.toLowerCase() : workspace)
  resumed.close()
  const unsafe = setup()
  symlinkSync(join(options.sessionDir, 'loop-controller'), join(unsafe.sessionDir, 'loop-controller'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(open(unsafe)).rejects.toThrow()
})
