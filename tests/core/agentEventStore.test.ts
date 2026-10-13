import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import type { AgentEventStore, AgentEventStoreOptions } from '../../src/core/agentEventStore.js'

const source = fileURLToPath(new URL('../../src/core/agentEventStore.ts', import.meta.url))
const fixture = fileURLToPath(new URL('../fixtures/agentEventCrash.mjs', import.meta.url))
const dirs: string[] = []
const children: ChildProcess[] = []
const stores: AgentEventStore[] = []
const turnId = 'turn-1'
const threadId = 'thread-1'

function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-agent-events-'))
  dirs.push(dir)
  return dir
}

async function open(dir: string, options: Partial<AgentEventStoreOptions> = {}): Promise<AgentEventStore> {
  expect(existsSync(source), 'durable client event store exists').toBe(true)
  const module = await import('../../src/core/agentEventStore.js')
  const store = new module.AgentEventStore({ sessionDir: dir, cwd: dir, threadId, ...options })
  stores.push(store)
  return store
}

function start(store: AgentEventStore, id = turnId, revision = 0): void {
  store.append({ type: 'turn.started', turnId: id, runId: id, cwd: store.snapshot().cwd, historyRevision: revision })
}

function finish(store: AgentEventStore, id = turnId, revision = 1): void {
  store.append({ type: 'turn.finished', turnId: id, status: 'completed', result: { stopped: false, reason: 'stop_sequence', output: 'done', status: 'completed', runId: id }, historyRevision: revision })
}

function segments(dir: string): string[] {
  return readdirSync(join(dir, 'agent-events')).filter(name => name.endsWith('.jsonl')).sort().map(name => join(dir, 'agent-events', name))
}

function worker(dir: string, mode = 'hold') {
  expect(existsSync(source), 'durable client event store exists').toBe(true)
  const runtime = join(dir, 'runtime')
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
  for (const name of ['agentEventStore', 'agentEvents', 'persistenceLock', 'processIdentity']) {
    const path = new URL(`../../src/core/${name}.ts`, import.meta.url)
    writeFileSync(join(runtime, `${name}.js`), transpileModule(readFileSync(path, 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 } }).outputText)
  }
  const child = fork(fixture, [dir, runtime, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  const messages: unknown[] = []
  let stderr = ''
  child.on('message', message => messages.push(message))
  child.stderr?.on('data', data => { stderr += String(data) })
  return { child, messages, diagnostics: () => stderr }
}

async function until(predicate: () => boolean): Promise<void> {
  const end = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Agent event process barrier timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL') })
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  await Promise.all(children.splice(0).map(kill))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('reopens consecutive durable events after killing the real writer and rejects a second live writer', async () => {
  const dir = directory()
  const writer = worker(dir)
  await until(() => writer.messages.includes('committed'))
  expect(writer.diagnostics()).toBe('')
  await expect(open(dir)).rejects.toThrow(/busy|owner/i)
  const reader = await open(dir, { readOnly: true })
  expect(reader.read(0).map(event => event.sequence)).toEqual([1, 2, 3, 4])
  await kill(writer.child)
  expect(reader.snapshot()).toMatchObject({ activeTurn: { turnId }, recovery: 'interrupted' })
  reader.close()
  const resumed = await open(dir)
  expect(resumed.append({ type: 'item.delta', turnId, itemId: 'message-1', text: 'next' }).sequence).toBe(5)
  expect(resumed.read(3).map(event => event.sequence)).toEqual([4, 5])
})

it('retains raw Unicode text and precise parallel tool identities in snapshots', async () => {
  const store = await open(directory())
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'read-a', kind: 'tool', name: 'Read', toolCallId: 'call-a', inputDigest: 'a', preview: 'a.txt' })
  store.append({ type: 'item.started', turnId, itemId: 'read-b', kind: 'tool', name: 'Read', toolCallId: 'call-b', inputDigest: 'b', preview: 'b.txt' })
  store.append({ type: 'item.completed', turnId, itemId: 'read-b', kind: 'tool', status: 'completed', result: { content: '乙', isError: false } })
  store.append({ type: 'item.completed', turnId, itemId: 'read-a', kind: 'tool', status: 'failed', result: { content: '甲', isError: true } })
  store.append({ type: 'item.started', turnId, itemId: 'message', kind: 'message', role: 'assistant' })
  store.append({ type: 'item.delta', turnId, itemId: 'message', text: '你好🙂 secret=visible' })
  store.append({ type: 'item.completed', turnId, itemId: 'message', kind: 'message', status: 'partial', result: '你好🙂 secret=visible' })
  expect(store.snapshot().items).toEqual(expect.arrayContaining([
    expect.objectContaining({ itemId: 'read-a', toolCallId: 'call-a', status: 'failed', result: { content: '甲', isError: true } }),
    expect.objectContaining({ itemId: 'read-b', toolCallId: 'call-b', status: 'completed', result: { content: '乙', isError: false } }),
    expect.objectContaining({ itemId: 'message', text: '你好🙂 secret=visible', status: 'partial' }),
  ]))
})

it('persists pending approvals and removes only decisions that actually resolve them', async () => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  const request = { requestId: 'approval-1', runId: turnId, operationId: 'write-1', inputDigest: 'digest', policyDigest: 'policy', cwd: dir, tool: 'Write', preview: 'file.txt' }
  store.append({ type: 'approval.requested', turnId, request })
  store.append({ type: 'approval.resolved', turnId, decision: { requestId: request.requestId, inputDigest: request.inputDigest, cwd: dir, action: 'deny', scope: 'once', status: 'needs_input' } })
  store.close()
  const reopened = await open(dir, { readOnly: true })
  expect(reopened.snapshot().pendingApprovals).toEqual([{ ...request, status: 'needs_input' }])
  reopened.close()
  const writer = await open(dir)
  writer.append({ type: 'approval.resolved', turnId, decision: { requestId: request.requestId, inputDigest: request.inputDigest, cwd: dir, action: 'deny', scope: 'once', status: 'decided' } })
  expect(writer.snapshot().pendingApprovals).toEqual([])
})

it('preserves unresolved approvals and refuses another turn until explicit recovery', async () => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  const request = { requestId: 'approval-1', runId: turnId, operationId: 'write-1', inputDigest: 'digest', policyDigest: 'policy', cwd: dir, tool: 'Write', preview: 'file.txt' }
  store.append({ type: 'approval.requested', turnId, request })
  store.append({ type: 'turn.finished', turnId, status: 'needs_input', result: { stopped: true, reason: 'error', output: 'approval pending', status: 'needs_input', runId: turnId }, historyRevision: 1 })
  store.checkpoint({ turnId, historyRevision: 1 })
  store.close()
  const reopened = await open(dir)
  expect(() => start(reopened, 'turn-2', 1)).toThrow(/unresolved approval|recovery/i)
  expect(reopened.snapshot()).toMatchObject({ lastSequence: 3, activeTurn: null, pendingApprovals: [{ ...request, status: 'needs_input' }] })
})

it('keeps history persistence failure recovery durable after the failed turn ends and reopens', async () => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  store.append({ type: 'error', turnId, code: 'history_persistence_failed', message: 'history unavailable' })
  store.append({ type: 'turn.finished', turnId, status: 'failed', result: { stopped: true, reason: 'error', output: 'history unavailable', status: 'failed', runId: turnId }, historyRevision: 0 })
  expect(store.snapshot().recovery).toBe('recovery_required')
  expect(() => store.checkpoint({ turnId, historyRevision: 0 })).toThrow(/recovery/i)
  store.close()
  const reopened = await open(dir)
  expect(reopened.snapshot()).toMatchObject({ activeTurn: null, recovery: 'recovery_required', lastTurn: { status: 'failed' } })
  expect(() => start(reopened, 'turn-2')).toThrow(/recovery/i)
})

it('rotates complete covered turns and exposes an exact replay boundary with a durable snapshot', async () => {
  const dir = directory()
  const store = await open(dir, { maxSegmentBytes: 900, maxSegments: 3, maxEventBytes: 700 })
  for (let index = 1; index <= 4; index++) {
    const id = `turn-${index}`
    start(store, id, index - 1)
    store.append({ type: 'item.started', turnId: id, itemId: 'text', kind: 'message', role: 'assistant' })
    store.append({ type: 'item.delta', turnId: id, itemId: 'text', text: '字'.repeat(100) })
    store.append({ type: 'item.completed', turnId: id, itemId: 'text', kind: 'message', status: 'completed', result: 'done' })
    finish(store, id, index)
    store.checkpoint({ historyRevision: index, turnId: id })
    expect(segments(dir).length).toBeLessThanOrEqual(3)
  }
  const snapshot = store.snapshot()
  expect(snapshot.firstAvailableSequence).toBeGreaterThan(1)
  const page = store.read(snapshot.firstAvailableSequence - 1)
  expect(page[0].sequence).toBe(snapshot.firstAvailableSequence)
  expect(new Set(page.map(event => event.sequence)).size).toBe(page.length)
  let expired: unknown
  try { store.read(snapshot.firstAvailableSequence - 2) } catch (error) { expired = error }
  expect(expired).toMatchObject({ code: 'cursor_expired', firstAvailableSequence: snapshot.firstAvailableSequence, snapshotPath: expect.any(String) })
  expect(JSON.parse(readFileSync((expired as { snapshotPath: string }).snapshotPath, 'utf8'))).toMatchObject({ threadId, historyRevision: 4, lastSequence: 20 })
  store.close()
  const reader = await open(dir, { readOnly: true, maxSegmentBytes: 900, maxSegments: 3, maxEventBytes: 700 })
  expect(reader.read(snapshot.firstAvailableSequence - 1).map(event => event.sequence)).toEqual(page.map(event => event.sequence))
})

it('refuses an overcapacity active tail without advancing sequence or deleting its events', async () => {
  const dir = directory()
  const store = await open(dir, { maxSegmentBytes: 700, maxSegments: 2, maxEventBytes: 650 })
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'text', kind: 'message', role: 'assistant' })
  store.append({ type: 'item.delta', turnId, itemId: 'text', text: 'x'.repeat(400) })
  const before = segments(dir).map(path => readFileSync(path, 'utf8'))
  expect(() => store.append({ type: 'item.delta', turnId, itemId: 'text', text: 'x'.repeat(400) })).toThrow(/capacity/i)
  expect(store.snapshot().lastSequence).toBe(3)
  expect(segments(dir).map(path => readFileSync(path, 'utf8'))).toEqual(before)
  expect(() => store.checkpoint({ turnId, historyRevision: 1 })).toThrow(/active|completed/i)
})

it('rejects partial crash tails and preserves the exact bytes for diagnosis', async () => {
  const dir = directory()
  const writer = worker(dir, 'partial')
  await until(() => writer.messages.includes('partial'))
  await kill(writer.child)
  const before = segments(dir).map(path => readFileSync(path))
  await expect(open(dir)).rejects.toMatchObject({ code: 'corrupt_event_store' })
  expect(segments(dir).map(path => readFileSync(path))).toEqual(before)
})

it('preserves an abandoned manifest temporary and requires recovery before another writer can accumulate more', async () => {
  const dir = directory()
  const writer = worker(dir, 'manifest-partial')
  await until(() => writer.messages.includes('manifest-partial'))
  await kill(writer.child)
  const files = readdirSync(join(dir, 'agent-events')).filter(name => name.includes('manifest.json.tmp-'))
  expect(files).toHaveLength(1)
  const path = join(dir, 'agent-events', files[0])
  const before = readFileSync(path)
  await expect(open(dir, { readOnly: true })).rejects.toMatchObject({ code: 'corrupt_event_store' })
  await expect(open(dir)).rejects.toMatchObject({ code: 'corrupt_event_store' })
  expect(readFileSync(path)).toEqual(before)
  expect(readdirSync(join(dir, 'agent-events')).filter(name => name.includes('manifest.json.tmp-'))).toEqual(files)
})

it.each(['json', 'duplicate', 'gap', 'identity', 'missing'])('fails closed on %s corruption without modifying original files', async corruption => {
  const dir = directory()
  const store = await open(dir, { maxSegmentBytes: 500, maxSegments: 8 })
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'text', kind: 'message', role: 'assistant' })
  for (let index = 0; index < 4; index++) store.append({ type: 'item.delta', turnId, itemId: 'text', text: `hello-${index}` })
  store.close()
  const paths = segments(dir)
  if (corruption === 'missing') unlinkSync(paths[1])
  else {
    const lines = readFileSync(paths[0], 'utf8').trimEnd().split('\n')
    const event = JSON.parse(lines[0]) as Record<string, unknown>
    if (corruption === 'json') lines[0] = '{broken'
    if (corruption === 'duplicate') { const last = JSON.parse(lines[1]) as Record<string, unknown>; last.sequence = event.sequence; lines[1] = JSON.stringify(last) }
    if (corruption === 'gap') event.sequence = 99
    if (corruption === 'identity') event.threadId = 'other-thread'
    if (corruption === 'gap' || corruption === 'identity') lines[0] = JSON.stringify(event)
    writeFileSync(paths[0], `${lines.join('\n')}\n`)
  }
  const remaining = segments(dir).map(path => [path, readFileSync(path)] as const)
  await expect(open(dir, { maxSegmentBytes: 500 })).rejects.toMatchObject({ code: 'corrupt_event_store' })
  for (const [path, bytes] of remaining) expect(readFileSync(path)).toEqual(bytes)
})

it('bounds UTF-8 event bytes and read pages and rejects unsafe cursors before writing', async () => {
  const store = await open(directory(), { maxEventBytes: 500, maxSegmentBytes: 100_000 })
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'text', kind: 'message', role: 'assistant' })
  expect(() => store.append({ type: 'item.delta', turnId, itemId: 'text', text: '🙂'.repeat(120) })).toThrow(/event.*bytes|event.*size/i)
  expect(store.snapshot().lastSequence).toBe(2)
  for (let index = 0; index < 260; index++) store.append({ type: 'item.delta', turnId, itemId: 'text', text: 'x' })
  expect(store.read(0, 1000)).toHaveLength(256)
  expect(() => store.read(-1)).toThrow(/cursor|sequence/i)
  expect(() => store.read(Number.MAX_SAFE_INTEGER + 1)).toThrow(/cursor|sequence/i)
})

it('keeps slow subscribers on a cursor and fails explicitly after retention overtakes them', async () => {
  const store = await open(directory(), { maxSegments: 2, maxSegmentBytes: 100_000 })
  start(store)
  const stream = store.subscribe(0)
  expect((await stream.next()).value).toMatchObject({ sequence: 1 })
  for (let index = 0; index < 300; index++) store.append({ type: 'error', turnId, code: 'visible', message: 'x'.repeat(200) })
  finish(store)
  store.checkpoint({ historyRevision: 1, turnId })
  start(store, 'turn-2', 1)
  finish(store, 'turn-2', 2)
  store.checkpoint({ historyRevision: 2, turnId: 'turn-2' })
  start(store, 'turn-3', 2)
  await expect(stream.next()).rejects.toMatchObject({ code: 'cursor_expired' })
})

it('cleans subscriptions on return, abort, and close without waiting for another event', async () => {
  const store = await open(directory())
  const stream = store.subscribe(0)
  const waiting = stream.next()
  await stream.return?.()
  expect(await waiting).toEqual({ value: undefined, done: true })
  const controller = new AbortController()
  const aborted = store.subscribe(0, { signal: controller.signal })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  const abortedNext = aborted.next()
  controller.abort()
  expect(await abortedNext).toEqual({ value: undefined, done: true })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  const closing = store.subscribe(0)
  const closedNext = closing.next()
  store.close()
  expect(await closedNext).toEqual({ value: undefined, done: true })
  expect((Reflect.get(store, 'subscriptions') as { size: number }).size).toBe(0)
})

it('cleans a subscription thrown a non-Error value and rejects with an Error', async () => {
  const store = await open(directory())
  const controller = new AbortController()
  const stream = store.subscribe(0, { signal: controller.signal })
  const waiting = stream.next()
  await expect(stream.throw?.('disconnected')).rejects.toBeInstanceOf(Error)
  expect(await waiting).toEqual({ value: undefined, done: true })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
})

it('polls committed events from an independent live writer without taking ownership', async () => {
  const dir = directory()
  const writer = worker(dir)
  await until(() => writer.messages.includes('committed'))
  const reader = await open(dir, { readOnly: true })
  const controller = new AbortController()
  const stream = reader.subscribe(4, { signal: controller.signal })
  const next = stream.next()
  writer.child.send('append')
  expect((await next).value).toMatchObject({ sequence: 5, type: 'item.delta', text: 'later' })
  expect(() => reader.append({ type: 'error', turnId, code: 'x', message: 'x' })).toThrow(/read.only/i)
  controller.abort()
})

it('rejects identity traversal and symlinked event storage before touching the target', async () => {
  const dir = directory()
  await expect(open(dir, { threadId: '../outside' })).rejects.toThrow(/identity|thread/i)
  const outside = directory()
  symlinkSync(outside, join(dir, 'agent-events'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(open(dir)).rejects.toThrow(/symbolic|symlink|path/i)
  expect(readdirSync(outside)).toEqual([])
})

it('does not silently accept an uncommitted complete suffix after a failed writer', async () => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  store.close()
  const path = segments(dir)[0]
  appendFileSync(path, `${JSON.stringify({ schemaVersion: 1, sequence: 2, threadId, turnId, type: 'error', code: 'uncommitted', message: 'tail' })}\n`)
  await expect(open(dir)).rejects.toMatchObject({ code: 'corrupt_event_store' })
})

it('commits the retention boundary before unlink and reopens after a crash in that window', async () => {
  const dir = directory()
  const writer = worker(dir, 'retention')
  await until(() => writer.messages.includes('manifest-committed'))
  expect(writer.diagnostics()).toBe('')
  expect(segments(dir)).toHaveLength(2)
  const reader = await open(dir, { readOnly: true, maxSegments: 1 })
  expect(() => reader.read(1)).toThrow(/cursor expired/i)
  expect(reader.read(2).map(event => event.sequence)).toEqual([3])
  await kill(writer.child)
  reader.close()
  const reopened = await open(dir, { maxSegments: 1 })
  expect(reopened.read(2).map(event => event.sequence)).toEqual([3])
  expect(reopened.snapshot()).toMatchObject({ firstAvailableSequence: 3, lastSequence: 3, recovery: 'interrupted' })
  expect(segments(dir)).toHaveLength(1)
})

it('fails the writer closed when retention cleanup fails after committing its boundary', async () => {
  const dir = directory()
  const store = await open(dir, { maxSegments: 1 })
  start(store)
  finish(store)
  store.checkpoint({ turnId, historyRevision: 1 })
  const original = fs.unlinkSync
  fs.unlinkSync = function (path: Parameters<typeof fs.unlinkSync>[0]) {
    if (String(path).endsWith('.jsonl')) throw new Error('Injected retained segment cleanup failure')
    return original(path)
  }
  syncBuiltinESMExports()
  try {
    expect(() => start(store, 'turn-2', 1)).toThrow('Injected retained segment cleanup failure')
  } finally {
    fs.unlinkSync = original
    syncBuiltinESMExports()
  }
  expect(() => store.append({ type: 'error', turnId: 'turn-2', code: 'after-cleanup-failure', message: 'must not append' })).toThrow(/writer failed/i)
  expect(JSON.parse(readFileSync(join(dir, 'agent-events', 'manifest.json'), 'utf8'))).toMatchObject({ firstAvailableSequence: 3, lastSequence: 3 })
})

it('publishes no event when log fsync fails and preserves the failed suffix after process death', async () => {
  const dir = directory()
  const writer = worker(dir, 'sync-failure')
  await until(() => writer.messages.includes('committed'))
  const reader = await open(dir, { readOnly: true })
  writer.child.send('append')
  await until(() => writer.messages.includes('fsync-failed'))
  expect(reader.read(4)).toEqual([])
  await kill(writer.child)
  reader.close()
  await expect(open(dir)).rejects.toMatchObject({ code: 'corrupt_event_store' })
})

it('rejects a failed suffix after its writer releases ownership while the process stays alive', async () => {
  const dir = directory()
  const writer = worker(dir, 'sync-failure')
  await until(() => writer.messages.includes('committed'))
  writer.child.send('append')
  await until(() => writer.messages.includes('fsync-failed'))
  writer.child.send('close')
  await until(() => writer.messages.includes('closed'))
  expect(writer.child.exitCode).toBeNull()
  await expect(open(dir, { readOnly: true })).rejects.toMatchObject({ code: 'corrupt_event_store' })
})

it('keeps only the latest checkpoint file after repeated complete turns', async () => {
  const dir = directory()
  const store = await open(dir, { maxSegments: 2 })
  for (let index = 1; index <= 4; index++) {
    const id = `turn-${index}`
    start(store, id, index - 1)
    finish(store, id, index)
    store.checkpoint({ historyRevision: index, turnId: id })
  }
  const snapshots = readdirSync(join(dir, 'agent-events')).filter(name => /^snapshot-\d+\.json$/.test(name))
  expect(snapshots).toHaveLength(1)
  expect(JSON.parse(readFileSync(join(dir, 'agent-events', snapshots[0]), 'utf8'))).toMatchObject({ historyRevision: 4, lastSequence: 8 })
})

it('rejects a terminal turn with an unterminated item without publishing it', async () => {
  const store = await open(directory())
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'text', kind: 'message', role: 'assistant' })
  expect(() => finish(store)).toThrow(/item.*terminal|item.*completed/i)
  expect(store.read(2)).toEqual([])
  expect(store.snapshot().activeTurn?.turnId).toBe(turnId)
})

it('retries a reader snapshot when a newer checkpoint replaces and removes its referenced file', async () => {
  const dir = directory()
  const writer = await open(dir)
  start(writer)
  finish(writer)
  writer.checkpoint({ turnId, historyRevision: 1 })
  const reader = await open(dir, { readOnly: true })
  const original = fs.openSync
  let interleaved = false
  fs.openSync = function (path: Parameters<typeof fs.openSync>[0], ...args: unknown[]) {
    if (!interleaved && String(path).includes('snapshot-')) {
      interleaved = true
      start(writer, 'turn-2', 1)
      finish(writer, 'turn-2', 2)
      writer.checkpoint({ turnId: 'turn-2', historyRevision: 2 })
    }
    return Reflect.apply(original, fs, [path, ...args]) as number
  }
  syncBuiltinESMExports()
  try {
    expect(reader.snapshot()).toMatchObject({ historyRevision: 2, lastSequence: 4, lastTurn: { turnId: 'turn-2' } })
  } finally {
    fs.openSync = original
    syncBuiltinESMExports()
  }
})

it('rejects malformed checkpoint items without returning an invented client snapshot', async () => {
  const dir = directory()
  const writer = await open(dir)
  start(writer)
  finish(writer)
  writer.checkpoint({ turnId, historyRevision: 1 })
  writer.close()
  const path = join(dir, 'agent-events', readdirSync(join(dir, 'agent-events')).find(name => /^snapshot-\d+\.json$/.test(name))!)
  const snapshot = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  snapshot.items = [{ itemId: 'invented', turnId, kind: 'message', status: 'running', text: 42 }]
  writeFileSync(path, JSON.stringify(snapshot))
  const before = readFileSync(path)
  await expect(open(dir, { readOnly: true })).rejects.toMatchObject({ code: 'corrupt_event_store' })
  expect(readFileSync(path)).toEqual(before)
})

it.each(['item-lifecycle', 'checkpoint-content'])('rejects %s corruption in a turn covered by the latest checkpoint', async corruption => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  store.append({ type: 'item.started', turnId, itemId: 'text', kind: 'message', role: 'assistant' })
  store.append({ type: 'item.delta', turnId, itemId: 'text', text: 'visible' })
  store.append({ type: 'item.completed', turnId, itemId: 'text', kind: 'message', status: 'completed', result: 'visible' })
  finish(store)
  store.checkpoint({ turnId, historyRevision: 1 })
  store.close()
  const path = corruption === 'item-lifecycle' ? segments(dir)[0] : join(dir, 'agent-events', readdirSync(join(dir, 'agent-events')).find(name => /^snapshot-\d+\.json$/.test(name))!)
  if (corruption === 'item-lifecycle') writeFileSync(path, readFileSync(path, 'utf8').replace('"itemId":"text"', '"itemId":"fake"'))
  else {
    const snapshot = JSON.parse(readFileSync(path, 'utf8')) as { items: { text: string }[] }
    snapshot.items[0].text = 'invented'
    writeFileSync(path, JSON.stringify(snapshot))
  }
  const before = readFileSync(path)
  await expect(open(dir, { readOnly: true })).rejects.toMatchObject({ code: 'corrupt_event_store' })
  expect(readFileSync(path)).toEqual(before)
})

it('persists explicit terminal truncation and artifact metadata through a checkpoint and reopen', async () => {
  const dir = directory()
  const store = await open(dir)
  start(store)
  store.append({ type: 'turn.finished', turnId, status: 'completed', result: { stopped: false, reason: 'stop_sequence', output: 'bounded', status: 'completed', runId: turnId }, historyRevision: 1, truncated: true, artifact: `agent-results/${turnId}.json` })
  expect(store.snapshot().lastTurn).toMatchObject({ truncated: true, artifact: `agent-results/${turnId}.json` })
  store.checkpoint({ turnId, historyRevision: 1 })
  store.close()
  const reader = await open(dir, { readOnly: true })
  expect(reader.snapshot().lastTurn).toMatchObject({ truncated: true, artifact: `agent-results/${turnId}.json` })
})

it.each(['manifest', 'checkpoint', 'segment'])('rejects an oversized %s from its descriptor size before reading its contents', async kind => {
  const dir = directory()
  const options = { maxSegmentBytes: 900, maxSegments: 2, maxEventBytes: 700 }
  const store = await open(dir, options)
  start(store)
  finish(store)
  store.checkpoint({ turnId, historyRevision: 1 })
  store.close()
  const path = kind === 'manifest' ? join(dir, 'agent-events', 'manifest.json') : kind === 'segment' ? segments(dir)[0] : join(dir, 'agent-events', readdirSync(join(dir, 'agent-events')).find(name => /^snapshot-\d+\.json$/.test(name))!)
  truncateSync(path, kind === 'manifest' ? 65_537 : kind === 'segment' ? 902 : 69_137)
  const originalReadFile = fs.readFileSync
  const originalRead = fs.readSync
  const originalOpen = fs.openSync
  const targetDescriptors = new Set<number>()
  fs.openSync = function (file: Parameters<typeof fs.openSync>[0], ...args: unknown[]) {
    const fd = Reflect.apply(originalOpen, fs, [file, ...args]) as number
    if (String(file) === path) targetDescriptors.add(fd)
    else targetDescriptors.delete(fd)
    return fd
  }
  fs.readFileSync = function (file: Parameters<typeof fs.readFileSync>[0], ...args: unknown[]) {
    if (String(file) === path) throw new Error('Injected barrier against unbounded content read')
    return Reflect.apply(originalReadFile, fs, [file, ...args]) as ReturnType<typeof fs.readFileSync>
  } as typeof fs.readFileSync
  fs.readSync = function (fd: number, ...args: unknown[]) {
    if (targetDescriptors.has(fd)) throw new Error('Injected barrier against premature descriptor read')
    return Reflect.apply(originalRead, fs, [fd, ...args]) as number
  }
  syncBuiltinESMExports()
  try {
    await expect(open(dir, { ...options, readOnly: true })).rejects.toThrow(/file byte limit/i)
  } finally {
    fs.readFileSync = originalReadFile
    fs.readSync = originalRead
    fs.openSync = originalOpen
    syncBuiltinESMExports()
  }
})
