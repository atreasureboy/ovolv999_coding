import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineObserver } from '../../src/core/engine/observer.js'
import { AgentService } from '../../src/core/agentService.js'
import { readSessionSnapshot, saveSession } from '../../src/core/sessionManager.js'
import { AgentEventStore } from '../../src/core/agentEventStore.js'
import { ApprovalBroker } from '../../src/core/approvalBroker.js'
import { prepareModelWindow, readModelWindow } from '../../src/core/agentSession.js'
import type { EngineConfig, OpenAIMessage, Tool } from '../../src/core/types.js'

const cleanups: Array<() => Promise<void>> = []
const quiet: EngineObserver = {
  startSpinner() {}, stopSpinner() {}, beginAssistantText() {}, streamToken() {}, endAssistantText() {},
  toolStart() {}, toolResult() {}, contextWarning() {}, compactStart() {}, compactDone() {}, warn() {}, error() {},
}

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function response(res: ServerResponse, text = 'ready') {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text, reasoning_content: 'opaque fixture reasoning' }, finish_reason: 'stop' }] })}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function fixture(handler?: (request: Record<string, unknown>, res: ServerResponse, index: number) => void, config: Partial<EngineConfig> = {}, timing: { deadlineMs?: number; finalizationGraceMs?: number } = {}, prepareEngine?: (engine: ExecutionEngine) => Promise<ExecutionEngine>) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-agent-service-'))
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += String(chunk) })
    req.on('end', () => {
      const request = JSON.parse(data) as Record<string, unknown>
      requests.push(request)
      if (handler) handler(request, res, requests.length)
      else response(res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const createService = () => {
    const service = new AgentService({ ...timing, engineFactory: context => {
      const engine = new ExecutionEngine({
      ...context, model: 'chat-fixture', apiKey: 'local-fixture', baseURL: `http://127.0.0.1:${address.port}/v1`,
      maxIterations: 4, permissionMode: 'auto', enabledModules: [], cancellationGraceMs: 30,
      agent: { identity: { systemPrompt: () => 'local fixture' }, tools: ['Read'] },
      ...config,
      }, quiet)
      return prepareEngine ? prepareEngine(engine) : engine
    } })
    cleanups.push(() => service.dispose())
    return service
  }
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    const absolute = join(tmpdir(), 'ovo-agent-service-')
    if (!cwd.startsWith(absolute)) throw new Error('Unexpected fixture path')
    rmSync(cwd, { recursive: true, force: true })
  })
  return { cwd, requests, service: createService(), createService }
}

function toolResponse(res: ServerResponse, name: string, input: Record<string, unknown>, id = name) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
  res.end('data: [DONE]\n\n')
}

it('binds turn identity to the real engine and persists full history across restart', async () => {
  const { cwd, requests, service, createService } = await fixture()
  const sessionDir = join(cwd, 'sessions', 'session_seed')
  mkdirSync(sessionDir, { recursive: true })
  const history: OpenAIMessage[] = Array.from({ length: 130 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `old ${index}` }))
  history[1].providerState = { protocol: 'chat', reasoning_content: 'old opaque state' }
  writeFileSync(join(sessionDir, 'history.json'), JSON.stringify(history))
  const { threadId } = await service.register({ sessionDir, cwd })
  const started = await service.start({ threadId, cwd, text: 'first' })
  const first = await service.wait(threadId, started.turnId)
  expect(first.result).toMatchObject({ runId: started.turnId, status: 'completed' })
  expect(first.newHistory).toHaveLength(132)
  expect(first.newHistory[1].providerState).toEqual(history[1].providerState)
  const saved = readSessionSnapshot(sessionDir)
  expect(saved.messages).toEqual(first.newHistory)
  expect((await service.snapshot(threadId)).lastTurn?.result?.runId).toBe(started.turnId)
  await service.release(threadId)
  const next = createService()
  expect((await next.register({ sessionDir, cwd })).threadId).toBe(threadId)
  const resumed = await next.start({ threadId, cwd, text: 'second' })
  const second = await next.wait(threadId, resumed.turnId)
  expect(second.result.status, second.result.output).toBe('completed')
  expect(second.newHistory).toHaveLength(134)
  expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'ready', reasoning_content: 'opaque fixture reasoning' }))
})

it('fences stale control, rejects concurrent starts, and steers inside the same real run', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, requests, service } = await fixture((_request, res, index) => {
    if (index === 1) { held = res; observed() }
    else response(res)
  })
  writeFileSync(join(cwd, 'target.txt'), 'fixture')
  const started = await service.start({ cwd, text: 'first' })
  await barrier
  await expect(service.start({ ...started, cwd, text: 'concurrent' })).rejects.toThrow(/active|progress/)
  await expect(service.steer(started.threadId, 'old-turn', 'wrong')).rejects.toThrow(/stale|turn/i)
  await expect(service.interrupt(started.threadId, 'old-turn')).rejects.toThrow(/stale|turn/i)
  await service.steer(started.threadId, started.turnId, '追加指令')
  held!.writeHead(200, { 'Content-Type': 'text/event-stream' })
  held!.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: join(cwd, 'target.txt') }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
  held!.end('data: [DONE]\n\n')
  const first = await service.wait(started.threadId, started.turnId)
  expect(first.result.runId).toBe(started.turnId)
  expect(requests).toHaveLength(2)
  expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: '追加指令' }))
  const second = await service.start({ threadId: started.threadId, cwd, text: 'second' })
  await expect(service.interrupt(started.threadId, started.turnId)).rejects.toThrow(/stale|turn/i)
  expect((await service.wait(second.threadId, second.turnId)).result.status).toBe('completed')
})

it('rejects a concurrent registration for the same session in another workspace', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const { cwd, service } = await fixture(undefined, {}, {}, async engine => { await barrier; return engine })
  const other = join(cwd, 'other')
  mkdirSync(other)
  const sessionDir = join(cwd, 'sessions', 'session_registration')
  mkdirSync(sessionDir, { recursive: true })
  const first = service.register({ sessionDir, cwd })
  const second = service.register({ sessionDir, cwd: other })
  release()
  await first
  await expect(second).rejects.toThrow(/workspace|conflict/i)
})

it('does not let a second service release the first service session ownership', async () => {
  const { cwd, service, createService } = await fixture()
  const sessionDir = join(cwd, 'sessions', 'session_owner')
  mkdirSync(sessionDir, { recursive: true })
  const { threadId } = await service.register({ sessionDir, cwd })
  const owner = readdirSync(join(sessionDir, 'writer.lock.owners'))
  const second = createService()
  await expect(second.register({ sessionDir, cwd })).rejects.toThrow(/owned|writer|lease/i)
  expect(readdirSync(join(sessionDir, 'writer.lock.owners'))).toEqual(owner)
  const started = await service.start({ threadId, cwd, text: 'still owned' })
  expect((await service.wait(threadId, started.turnId)).result.status).toBe('completed')
})

it('rejects a concurrent session directory claiming an already registering thread identity', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const { cwd, service } = await fixture(undefined, {}, {}, async engine => { await barrier; return engine })
  const firstDir = join(cwd, 'sessions', 'session_identity_first')
  const secondDir = join(cwd, 'sessions', 'session_identity_second')
  mkdirSync(firstDir, { recursive: true })
  mkdirSync(secondDir, { recursive: true })
  saveSession(firstDir, [])
  const envelope = readSessionSnapshot(firstDir)
  writeFileSync(join(secondDir, 'history.json'), JSON.stringify(envelope))
  const first = service.register({ sessionDir: firstDir, cwd })
  const second = service.register({ sessionDir: secondDir, cwd })
  release()
  const registered = await first
  await expect(second).rejects.toThrow(/identity|conflict/i)
  const started = await service.start({ threadId: registered.threadId, cwd, text: 'first directory' })
  expect((await service.wait(registered.threadId, started.turnId)).result.status).toBe('completed')
})

it('waits for in-flight registration during disposal and releases its resources', async () => {
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const { cwd, service, createService } = await fixture(undefined, {}, {}, async engine => { await barrier; return engine })
  const sessionDir = join(cwd, 'sessions', 'session_disposal')
  mkdirSync(sessionDir, { recursive: true })
  const registration = service.register({ sessionDir, cwd })
  const disposal = service.dispose()
  release()
  await disposal
  await expect(registration).rejects.toThrow(/disposed/i)
  const next = createService()
  await expect(next.register({ sessionDir, cwd })).resolves.toHaveProperty('threadId')
})

it('persists acknowledged steering text before the model consumes it', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'first' })
  await barrier
  await service.steer(started.threadId, started.turnId, 'durable instruction 🙂')
  const snapshot = await service.snapshot(started.threadId)
  const reader = new AgentEventStore({ sessionDir: service.engineForThread(started.threadId).getConfig().sessionDir!, cwd, threadId: started.threadId, readOnly: true })
  const persisted = reader.snapshot()
  reader.close()
  response(held!)
  await service.wait(started.threadId, started.turnId)
  expect(snapshot.items.find(item => item.expectedTurnId === started.turnId)?.text).toBe('durable instruction 🙂')
  expect(persisted.items.find(item => item.expectedTurnId === started.turnId)?.text).toBe('durable instruction 🙂')
})

it('bounds completed turn retention while preserving the current wait result', async () => {
  const { cwd, service } = await fixture()
  const first = await service.start({ cwd, text: 'first' })
  await service.wait(first.threadId, first.turnId)
  const second = await service.start({ cwd, threadId: first.threadId, text: 'second' })
  expect((await service.wait(second.threadId, second.turnId)).newHistory).toHaveLength(4)
  await expect(service.wait(first.threadId, first.turnId)).rejects.toMatchObject({ code: 'unknown_turn' })
})

it('rejects subscriber reads when terminal persistence fails', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'first' })
  await barrier
  const store = (service as unknown as { threads: Map<string, { store: AgentEventStore }> }).threads.get(started.threadId)!.store
  const append = store.append.bind(store)
  vi.spyOn(store, 'append').mockImplementation(event => {
    if (event.type === 'turn.finished') throw new Error('terminal persistence probe')
    return append(event)
  })
  const iterator = service.subscribe(started.threadId, (await service.snapshot(started.threadId)).lastSequence)[Symbol.asyncIterator]()
  const reading = (async () => { for (;;) { const event = await iterator.next(); if (event.done) return; } })()
  const checkedRead = expect(reading).rejects.toThrow(/terminal persistence probe/)
  response(held!)
  await expect(service.wait(started.threadId, started.turnId)).rejects.toThrow(/terminal persistence probe/)
  await Promise.race([checkedRead, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('subscriber remained pending')), 250))])
})

it.each([
  { name: 'Unicode', output: '🙂'.repeat(40000), responseSchema: undefined },
  { name: 'structured JSON', output: JSON.stringify('x'.repeat(140000)), responseSchema: { type: 'string' } },
  { name: 'escaped controls', output: '\u0001'.repeat(22000), responseSchema: undefined },
])('publishes an explicit result artifact for large accepted $name output', async ({ output, responseSchema }) => {
  const { cwd, service } = await fixture((_request, res) => response(res, output), { modelSettings: { 'chat-fixture': { capabilities: { structuredOutput: true } } } })
  const started = await service.start({ cwd, text: 'large output', responseSchema })
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.result.status).toBe('completed')
  expect(outcome.result.output).toBe(output)
  const terminal = (await service.snapshot(started.threadId)).lastTurn!
  expect(terminal).toMatchObject({ truncated: true, artifact: `agent-results/${started.turnId}.json` })
  const sessionDir = service.engineForThread(started.threadId).getConfig().sessionDir!
  expect(JSON.parse(readFileSync(join(sessionDir, (terminal as typeof terminal & { artifact: string }).artifact), 'utf8'))).toEqual(outcome.result)
})

it('rejects and wakes subscribers when the bounded result artifact cannot be saved', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'large output' })
  await barrier
  const sessionDir = service.engineForThread(started.threadId).getConfig().sessionDir!
  mkdirSync(join(sessionDir, 'agent-results', started.turnId + '.json'), { recursive: true })
  const iterator = service.subscribe(started.threadId, (await service.snapshot(started.threadId)).lastSequence)[Symbol.asyncIterator]()
  const reading = (async () => { for (;;) { const event = await iterator.next(); if (event.done) return; } })()
  const checkedRead = expect(reading).rejects.toThrow(/Unsafe service data file/)
  response(held!, 'x'.repeat(140000))
  await expect(service.wait(started.threadId, started.turnId)).rejects.toThrow(/Unsafe service data file/)
  await Promise.race([checkedRead, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('subscriber remained pending')), 250))])
  expect((await service.snapshot(started.threadId)).recovery).toBe('recovery_required')
})

it('falls back from malformed projection messages to validated canonical history', async () => {
  const { cwd } = await fixture()
  const canonical: OpenAIMessage[] = [{ role: 'user', content: 'canonical' }]
  writeFileSync(join(cwd, 'agent-model-window.json'), JSON.stringify({ version: 1, historyRevision: 3, messages: [null] }))
  expect(readModelWindow(cwd, 3, canonical)).toEqual(canonical)
})

it('bounds a model projection even when one canonical message exceeds its capacity', () => {
  const canonical: OpenAIMessage[] = [{ role: 'user', content: 'x'.repeat(8 * 1024 * 1024) }, { role: 'assistant', content: 'recent' }]
  const projection = prepareModelWindow(canonical, true)
  expect(Buffer.byteLength(JSON.stringify({ version: 1, historyRevision: Number.MAX_SAFE_INTEGER, messages: projection }))).toBeLessThanOrEqual(8 * 1024 * 1024)
  expect(projection.at(-1)?.content).toBe('recent')
  expect(canonical[0].content).toHaveLength(8 * 1024 * 1024)
})

it('keeps the owned run alive when a subscriber disconnects', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'first' })
  const iterator = service.subscribe(started.threadId, 0)[Symbol.asyncIterator]()
  expect((await iterator.next()).value.type).toBe('turn.started')
  await iterator.return?.()
  await barrier
  response(held!)
  expect((await service.wait(started.threadId, started.turnId)).result.status).toBe('completed')
})

it('returns a pending subscription immediately without cancelling the run', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'first' })
  await barrier
  const cursor = (await service.snapshot(started.threadId)).lastSequence
  const iterator = service.subscribe(started.threadId, cursor)[Symbol.asyncIterator]()
  const pending = iterator.next()
  const returned = iterator.return!()
  const immediate = await Promise.race([returned.then(() => true), new Promise<boolean>(resolve => setTimeout(() => resolve(false), 100))])
  response(held!)
  await pending
  expect((await service.wait(started.threadId, started.turnId)).result.status).toBe('completed')
  expect(immediate).toBe(true)
})

it('does not publish completed when durable history saving conflicts', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, requests, service, createService } = await fixture((_request, res) => { held = res; observed() })
  const sessionDir = join(cwd, 'sessions', 'session_conflict')
  mkdirSync(sessionDir, { recursive: true })
  saveSession(sessionDir, [])
  const { threadId } = await service.register({ cwd, sessionDir })
  const started = await service.start({ threadId, cwd, text: 'first' })
  await barrier
  const envelope = readSessionSnapshot(sessionDir)
  writeFileSync(join(sessionDir, 'history.json'), JSON.stringify({ ...envelope, revision: 10 }))
  response(held!)
  const outcome = await service.wait(threadId, started.turnId)
  expect(outcome.result.status).toBe('failed')
  expect((await service.snapshot(threadId)).lastTurn?.status).not.toBe('completed')
  expect(readSessionSnapshot(sessionDir).revision).toBe(10)
  await service.release(threadId)
  const reopened = createService()
  await reopened.register({ sessionDir, cwd })
  expect((await reopened.snapshot(threadId)).recovery).toBe('recovery_required')
  await expect(reopened.start({ threadId, cwd, text: 'must not replay' })).rejects.toThrow(/recovery/)
  expect(requests).toHaveLength(1)
})

it('marks an unfinished durable turn for recovery on reopen without replaying it', async () => {
  const { cwd, requests, service } = await fixture()
  const sessionDir = join(cwd, 'sessions', 'session_crash')
  mkdirSync(sessionDir, { recursive: true })
  const threadId = readSessionSnapshot(sessionDir).sessionId
  const store = new AgentEventStore({ sessionDir, cwd, threadId })
  store.append({ type: 'turn.started', turnId: 'crashed-turn', runId: 'crashed-turn', cwd, historyRevision: 0 })
  store.close()
  await service.register({ sessionDir, cwd })
  expect((await service.snapshot(threadId)).recovery).toBe('recovery_required')
  await expect(service.start({ threadId, cwd, text: 'replay' })).rejects.toThrow(/recovery/i)
  expect(requests).toHaveLength(0)
  expect((await service.snapshot(threadId)).activeTurn?.turnId).toBe('crashed-turn')
})

it('persists paired real Read/Edit/Bash history and acceptance before publishing completed', async () => {
  let target = ''
  const { cwd, service } = await fixture((_request, res, index) => {
    if (index === 1) toolResponse(res, 'Read', { file_path: target })
    else if (index === 2) toolResponse(res, 'Edit', { file_path: target, old_string: '1', new_string: '2' })
    else if (index === 3) toolResponse(res, 'Bash', { command: 'node verify.mjs' })
    else response(res)
  }, { maxIterations: 5, agent: { identity: { systemPrompt: () => 'local fixture' }, tools: ['Read', 'Edit', 'Bash'] } })
  target = join(cwd, 'target.txt')
  writeFileSync(target, '1')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.mjs' } }))
  writeFileSync(join(cwd, 'verify.mjs'), "import { readFileSync } from 'node:fs'; if (readFileSync('target.txt', 'utf8') !== '2') throw new Error('not edited')")
  const started = await service.start({ cwd, text: 'read edit and verify' })
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.result.status, outcome.result.output).toBe('completed')
  expect(outcome.result.verification?.status).toBe('passed')
  expect(readFileSync(target, 'utf8')).toBe('2')
  for (const name of ['Read', 'Edit', 'Bash']) {
    expect(outcome.newHistory.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === name))).toBe(true)
    expect(outcome.newHistory.some(message => message.role === 'tool' && message.tool_call_id === name)).toBe(true)
  }
  const snapshot = await service.snapshot(started.threadId)
  expect(snapshot.lastTurn?.status).toBe('completed')
  expect(snapshot.historyRevision).toBeGreaterThan(0)
})

it('retains repeated prompt text as separate canonical turns', async () => {
  const { cwd, service } = await fixture()
  const first = await service.start({ cwd, text: 'same prompt' })
  await service.wait(first.threadId, first.turnId)
  const second = await service.start({ cwd, threadId: first.threadId, text: 'same prompt' })
  const outcome = await service.wait(second.threadId, second.turnId)
  expect(outcome.result.status).toBe('completed')
  expect(outcome.newHistory.filter(message => message.role === 'user' && message.content === 'same prompt')).toHaveLength(2)
  expect(outcome.newHistory).toHaveLength(4)
})

it('retains acknowledged steering that arrives during the final model response', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, requests, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'same text' })
  await barrier
  await service.steer(started.threadId, started.turnId, 'same text')
  response(held!)
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.result.status).toBe('interrupted')
  expect(outcome.newHistory.filter(message => message.role === 'user' && message.content === 'same text')).toHaveLength(2)
  expect((await service.snapshot(started.threadId)).items.some(item => item.expectedTurnId === started.turnId && item.status === 'partial')).toBe(true)
  expect(requests).toHaveLength(1)
})

it('bounds steering per turn before accepting an over-limit message', async () => {
  let held: ServerResponse | undefined
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, service } = await fixture((_request, res) => { held = res; observed() })
  const started = await service.start({ cwd, text: 'first' })
  await barrier
  await expect(service.steer(started.threadId, started.turnId, '🙂'.repeat(32769))).rejects.toThrow(/capacity/)
  for (let index = 0; index < 32; index++) await service.steer(started.threadId, started.turnId, `steer ${index}`)
  await expect(service.steer(started.threadId, started.turnId, 'too many')).rejects.toThrow(/capacity/)
  response(held!)
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.newHistory.filter(message => typeof message.content === 'string' && message.content.startsWith('steer '))).toHaveLength(32)
})

it('runs two independent workspaces concurrently through one service', async () => {
  const held: ServerResponse[] = []
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const { cwd, requests, service } = await fixture((_request, res) => { held.push(res); if (held.length === 2) observed() })
  const other = mkdtempSync(join(tmpdir(), 'ovo-agent-other-'))
  cleanups.push(async () => { await Promise.resolve(); if (!other.startsWith(join(tmpdir(), 'ovo-agent-other-'))) throw new Error('Unexpected fixture path'); rmSync(other, { recursive: true, force: true }) })
  const first = await service.start({ cwd, text: 'first' })
  const second = await service.start({ cwd: other, text: 'second' })
  await barrier
  expect(requests).toHaveLength(2)
  held.forEach(res => response(res))
  expect((await service.wait(first.threadId, first.turnId)).result.status).toBe('completed')
  expect((await service.wait(second.threadId, second.turnId)).result.status).toBe('completed')
  await service.release(second.threadId)
})

it('persists needs_input approval when the approval host disconnects without executing Write', async () => {
  const broker = new ApprovalBroker()
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  broker.attachHost({ request: () => { observed(); return new Promise<never>(() => {}) } })
  let target = ''
  const { cwd, service } = await fixture((_request, res, index) => {
    if (index === 1) toolResponse(res, 'Write', { file_path: target, content: 'not authorized' })
    else response(res)
  }, { approvalBroker: broker, permissionMode: 'ask', agent: { identity: { systemPrompt: () => 'local fixture' }, tools: ['Write'] } })
  target = join(cwd, 'must-not-exist.txt')
  const started = await service.start({ cwd, text: 'write with approval' })
  service.engineForThread(started.threadId).getPermissionManager().addRule({ toolName: 'Write', ruleContent: '*', behavior: 'ask', source: 'user' })
  await barrier
  broker.disconnectHost()
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.result.status).toBe('needs_input')
  expect(existsSync(target)).toBe(false)
  expect((await service.snapshot(started.threadId)).pendingApprovals).toMatchObject([{ runId: started.turnId, tool: 'Write', status: 'needs_input' }])
  await expect(service.start({ threadId: started.threadId, cwd, text: 'must not bypass approval' })).rejects.toThrow(/recovery/)
})

it('blocks another turn while a deadline-cancelled real tool remains physically unsettled', async () => {
  let release!: () => void
  let observed!: () => void
  const barrier = new Promise<void>(resolve => { observed = resolve })
  const pending = new Promise<{ content: string; isError: boolean }>(resolve => { release = () => resolve({ content: 'settled', isError: false }) })
  const tool: Tool = {
    name: 'PhysicalProbe', metadata: { readOnly: true, concurrencySafe: true },
    definition: { type: 'function', function: { name: 'PhysicalProbe', description: 'local physical settlement barrier', parameters: { type: 'object', properties: {} } } },
    execute: () => { observed(); return pending },
  }
  const { cwd, requests, service } = await fixture((_request, res) => toolResponse(res, 'PhysicalProbe', {}), {
    extraTools: [tool], agent: { identity: { systemPrompt: () => 'local fixture' }, tools: ['PhysicalProbe'] },
  }, { deadlineMs: 1000, finalizationGraceMs: 100 })
  const started = await service.start({ cwd, text: 'wait for a physical tool' })
  await barrier
  const outcome = await service.wait(started.threadId, started.turnId)
  expect(outcome.result.status).toBe('blocked')
  await expect(service.start({ threadId: started.threadId, cwd, text: 'must wait' })).rejects.toThrow(/unfinished|active|quarantined/)
  expect(requests).toHaveLength(1)
  release()
  await vi.waitFor(() => expect(outcome.result.unfinishedResources?.length ?? 1).toBeGreaterThan(0))
})
