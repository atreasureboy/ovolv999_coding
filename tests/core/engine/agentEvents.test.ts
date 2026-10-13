import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { RunStore } from '../../../src/core/runStore.js'
import { TurnEvents } from '../../../src/core/engine/events.js'
import type { VerificationEvidence } from '../../../src/core/outcome.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'
import type { EngineConfig, Tool } from '../../../src/core/types.js'
import type { AgentEventInput } from '../../../src/core/agentEvents.js'

const fixtures: Array<{ base: string; engine: ExecutionEngine; server?: Server }> = []
afterEach(async () => {
  for (const { base, engine, server } of fixtures.splice(0)) {
    await engine.dispose()
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    rmSync(base, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function setup(responses: Array<Record<string, unknown>>, overrides: Partial<EngineConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-engine-events-'))
  const cwd = join(base, 'workspace'), state = join(base, 'runtime')
  mkdirSync(cwd)
  vi.stubEnv('OVOGO_STATE_DIR', state)
  const requests: Record<string, unknown>[] = []
  const client = { chat: { completions: { create: (request: Record<string, unknown>) => {
    requests.push(request)
    const response = responses[Math.min(requests.length - 1, responses.length - 1)]
    return Promise.resolve((async function* () { yield await Promise.resolve(response) })())
  } } } } as unknown as OpenAI
  const engine = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'fixture', maxIterations: 4, permissionMode: 'auto', enabledModules: [], agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['Read', 'Write', 'Probe'] }, ...overrides }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver, client)
  fixtures.push({ base, engine })
  return { engine, cwd, state, requests }
}

const answer = { choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }] }
const calls = (values: Array<{ id: string; name: string; input: Record<string, unknown> }>) => ({ choices: [{ delta: { tool_calls: values.map((call, index) => ({ index, id: call.id, function: { name: call.name, arguments: JSON.stringify(call.input) } })) }, finish_reason: 'tool_calls' }] })

it('uses the reserved identity and pairs parallel same-name tools by actual call ID', async () => {
  let releaseFirst!: () => void
  const first = new Promise<void>(resolve => { releaseFirst = resolve })
  const completion: number[] = []
  const probe: Tool = { name: 'Probe', metadata: { readOnly: true, concurrencySafe: true }, definition: { type: 'function', function: { name: 'Probe', description: 'fixture', parameters: { type: 'object', properties: { order: { type: 'number' } } } } }, execute: async input => {
    if (input.order === 1) await first
    else releaseFirst()
    completion.push(Number(input.order))
    return { content: String(input.order), isError: false }
  } }
  const { engine, state } = setup([calls([{ id: 'one', name: 'Probe', input: { order: 1 } }, { id: 'two', name: 'Probe', input: { order: 2 } }]), answer], { extraTools: [probe] })
  const events: AgentEventInput[] = []
  const runId = randomUUID()
  const out = await engine.runTurn('probe', [], undefined, { runId, events: { emit: event => { events.push(event) } } })
  expect(out.result).toMatchObject({ status: 'completed', runId })
  expect(RunStore.inspect(join(state, 'runs', runId + '.json')).runId).toBe(runId)
  expect(completion).toEqual([2, 1])
  const started = events.filter((event): event is Extract<AgentEventInput, { type: 'item.started' }> => event.type === 'item.started' && event.kind === 'tool')
  expect(started.map(event => event.toolCallId)).toEqual(['one', 'two'])
  for (const item of started) expect(events.filter(event => event.type === 'item.completed' && event.itemId === item.itemId)).toEqual([expect.objectContaining({ result: expect.objectContaining({ content: item.toolCallId === 'one' ? '1' : '2' }) })])
  expect(events.every(event => event.turnId === runId)).toBe(true)
})

it('does not reuse a durable run identity or leave the engine in-flight after invalid identity', async () => {
  const { engine, requests } = setup([answer])
  await expect(engine.runTurn('bad', [], undefined, { runId: '../escape' })).rejects.toThrow(/identity/i)
  const runId = randomUUID()
  expect((await engine.runTurn('first', [], undefined, { runId })).result.status).toBe('completed')
  expect((await engine.runTurn('duplicate', [], undefined, { runId })).result.status).toBe('failed')
  expect(requests).toHaveLength(1)
  expect((await engine.runTurn('next', [])).result.status).toBe('completed')
})

it('terminates a partial message when a real HTTP stream disconnects', async () => {
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: {"choices":[{"index":0,"delta":{"content":"部分输出"}}]}\n\n')
      setTimeout(() => response.destroy(), 20)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  const base = mkdtempSync(join(tmpdir(), 'ovo-event-stream-'))
  vi.stubEnv('OVOGO_STATE_DIR', join(base, 'runtime'))
  const cwd = join(base, 'workspace'); mkdirSync(cwd)
  const engine = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, maxIterations: 1, permissionMode: 'deny', enabledModules: [], agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] } }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver)
  fixtures.push({ base, engine, server })
  const events: AgentEventInput[] = []
  const out = await engine.runTurn('partial', [], undefined, { events: { emit: event => { events.push(event) } } })
  expect(out.result.status).toBe('failed')
  expect(out.turnMessages).toContainEqual(expect.objectContaining({ role: 'assistant', content: '部分输出' }))
  const item = events.find((event): event is Extract<AgentEventInput, { type: 'item.started' }> => event.type === 'item.started' && event.kind === 'message' && event.role === 'assistant')
  expect(item).toBeDefined()
  expect(events.filter((event): event is Extract<AgentEventInput, { type: 'item.delta' }> => event.type === 'item.delta' && event.itemId === item?.itemId).map(event => event.text).join('')).toBe('部分输出')
  expect(events.filter(event => event.type === 'item.completed' && event.itemId === item?.itemId)).toEqual([expect.objectContaining({ status: 'failed', result: '部分输出' })])
})

it('retains real file evidence and fails the turn if event persistence fails after Write', async () => {
  const { engine, cwd, state, requests } = setup([calls([{ id: 'write', name: 'Write', input: { file_path: 'value.txt', content: 'once' } }]), answer])
  const out = await engine.runTurn('write', [], undefined, { events: { emit: event => {
    if (event.type === 'item.completed' && event.kind === 'tool') throw new Error('event persistence refused')
  } } })
  expect(readFileSync(join(cwd, 'value.txt'), 'utf8')).toBe('once')
  expect(out.result.status).toBe('failed')
  expect(requests).toHaveLength(1)
  expect(Object.values(RunStore.inspect(join(state, 'runs', out.result.runId + '.json')).operations)).toEqual([expect.objectContaining({ name: 'Write', receipt: expect.objectContaining({ effects: 'observed_applied' }) })])
})

it('accepts steering in the same run before the next model request', async () => {
  const { engine, cwd, requests } = setup([calls([{ id: 'read', name: 'Read', input: { file_path: 'value.txt' } }]), answer])
  writeFileSync(join(cwd, 'value.txt'), 'fixture')
  let drains = 0
  const events: AgentEventInput[] = []
  const out = await engine.runTurn('read', [], undefined, { events: { emit: event => { events.push(event) } }, takeSteering: () => ++drains === 2 ? [{ id: 'steer-one', text: 'additional user direction' }] : [] })
  expect(out.result.status).toBe('completed')
  expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'user', content: 'additional user direction' }))
  expect(out.newHistory).toContainEqual(expect.objectContaining({ role: 'user', content: 'additional user direction' }))
  expect(out.turnMessages?.filter(message => message.role === 'user').map(message => message.content)).toEqual(['read', 'additional user direction'])
  expect(events.filter(event => event.type === 'item.started' && event.itemId === 'steer-one')).toHaveLength(1)
})

it('bounds encoded event bytes when text contains JSON control characters', async () => {
  const { engine } = setup([{ choices: [{ delta: { content: '\u0001'.repeat(22_000) }, finish_reason: 'stop' }] }])
  const events: AgentEventInput[] = []
  const out = await engine.runTurn('respond', [], undefined, { events: { emit: event => {
    if (Buffer.byteLength(JSON.stringify(event)) > 128 * 1024) throw new Error('encoded event too large')
    events.push(event)
  } } })
  expect(out.result.status).toBe('completed')
  expect(events.filter(event => event.type === 'item.completed' && event.itemId.startsWith('assistant:'))).toEqual([expect.objectContaining({ truncated: true, status: 'completed' })])
})

it('bounds nested verification evidence without changing its acceptance status', () => {
  const verification: VerificationEvidence = { status: 'failed', sufficientForCompletion: false, workspace: '.', output: 'failed'.repeat(30_000), commands: Array.from({ length: 32 }, (_, index) => ({ command: `check ${index}`, output: '\u0001'.repeat(16_384), passed: false, exitCode: 1 })) }
  const events: AgentEventInput[] = []
  new TurnEvents('turn', { emit: event => { events.push(event) } }).complete('tool', 'tool', { content: 'failed', isError: true, verification }, 'failed')
  expect(Buffer.byteLength(JSON.stringify(events[0]))).toBeLessThan(128 * 1024)
  expect(events[0]).toMatchObject({ truncated: true, status: 'failed', result: { verification: { status: 'failed', sufficientForCompletion: false } } })
  expect(verification.commands).toHaveLength(32)
})
