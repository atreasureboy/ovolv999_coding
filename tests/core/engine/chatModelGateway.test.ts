import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'
import type OpenAI from 'openai'

const fixtures: Array<{ engine: ExecutionEngine; server: Server; cwd: string }> = []
const mocks: Array<{ engine: ExecutionEngine; cwd: string }> = []
afterEach(async () => {
  vi.useRealTimers()
  for (const { engine, cwd } of mocks.splice(0)) { await engine.dispose(); rmSync(cwd, { recursive: true, force: true }) }
  for (const { engine, server, cwd } of fixtures.splice(0)) {
    await engine.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(cwd, { recursive: true, force: true })
  }
})

async function setup(chunks: Record<string, unknown>[], completion?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += String(chunk) })
    req.on('end', () => {
      requests.push(JSON.parse(data) as Record<string, unknown>)
      if (completion) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(completion))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      res.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-chat-gateway-'))
  const engine = new ExecutionEngine({ cwd, apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'chat-fixture', maxIterations: 1, permissionMode: 'deny', enabledModules: [], agent: { identity: { systemPrompt: () => 'project requirements' }, tools: [] } }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver)
  fixtures.push({ engine, server, cwd })
  return { engine, requests }
}

it('fails a real engine turn when Chat ends without a completion reason', async () => {
  const { engine, requests } = await setup([{ choices: [{ index: 0, delta: { content: 'partial' } }] }])
  const result = await engine.runTurn('first', [])
  expect(result.result.status).toBe('failed')
  expect(requests).toHaveLength(1)
  expect(engine.getCostTracker().getUsageSummary()).toMatchObject({ requestCount: 1, unknownRequestCount: 1 })
})

it('preserves opaque Chat reasoning through persisted engine history', async () => {
  const { engine, requests } = await setup([
    { choices: [{ index: 0, delta: { reasoning_content: 'opaque reasoning', reasoning_details: [{ type: 'reasoning.encrypted', data: 'fixture' }], content: 'ready' }, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } },
  ])
  const first = await engine.runTurn('first', [])
  expect(first.result.status, JSON.stringify(first.result)).toBe('completed')
  expect(first.newHistory.find(message => message.role === 'assistant')?.providerState).toBeDefined()
  const second = await engine.runTurn('second', JSON.parse(JSON.stringify(first.newHistory)))
  expect(second.result.status).toBe('completed')
  expect(requests[1].messages).toContainEqual(expect.objectContaining({ role: 'assistant', content: 'ready', reasoning_content: 'opaque reasoning', reasoning_details: [{ type: 'reasoning.encrypted', data: 'fixture' }] }))
})

it('rejects a mutating Chat tool identity in the production gateway', async () => {
  const { engine, requests } = await setup([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'first', type: 'function', function: { name: 'Read', arguments: '{' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'changed', function: { arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
  ])
  await expect((async () => {
    const response = await engine.getModelClient().chat.completions.create({ model: 'chat-fixture', messages: [{ role: 'user', content: 'tool identity' }], max_tokens: 32, stream: true })
    for await (const chunk of response) void chunk
  })()).rejects.toThrow(/identity changed/)
  expect(requests).toHaveLength(1)
})

it('normalizes non-streaming Chat tool calls without requiring wire stream indexes', async () => {
  const { engine } = await setup([], { choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function', function: { name: 'Read', arguments: '{}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 10 } })
  const response = await engine.getModelClient().chat.completions.create({ model: 'chat-fixture', messages: [{ role: 'user', content: 'tool identity' }], max_tokens: 32 })
  expect(response.choices[0].message.tool_calls).toEqual([{ id: 'one', type: 'function', function: { name: 'Read', arguments: '{}' } }])
  expect(engine.getCostTracker().getUsageSummary()).toMatchObject({ requestCount: 1, actualRequestCount: 1 })
})

it.each(['reasoning_content', 'reasoning_details', 'thinking-tags'])('observes active %s without displaying private reasoning', async kind => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  let begin!: () => void
  const started = new Promise<void>(resolve => { begin = resolve })
  const client = { chat: { completions: { create: () => Promise.resolve({ async *[Symbol.asyncIterator]() {
    begin()
    for (let at = 0; at < 6; at++) {
      await new Promise<void>(resolve => setTimeout(resolve, 30_000))
      const delta = kind === 'reasoning_details' ? { reasoning_details: [{ type: 'reasoning.encrypted', data: 'private' }] } : kind === 'thinking-tags' ? { content: (at === 0 ? '<think>' : '') + 'private' } : { reasoning_content: 'private' }
      yield { choices: [{ index: 0, delta }] }
    }
    yield { choices: [{ index: 0, delta: { content: (kind === 'thinking-tags' ? '</think>' : '') + 'ready' }, finish_reason: 'stop' }] }
  } }) } } } as unknown as OpenAI
  const displayed: string[] = []
  const observer = new Proxy({}, { get: (_target, key) => key === 'streamReasoning' || key === 'streamToken' ? (value: string) => { displayed.push(value) } : vi.fn() }) as EngineObserver
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-chat-activity-'))
  const engine = new ExecutionEngine({ cwd, model: 'chat-fixture', apiKey: 'fixture-only', maxIterations: 1, permissionMode: 'deny', enabledModules: [], modelGateway: { deadlineMs: 600_000, maxAttempts: 1 }, agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] } }, observer, client)
  mocks.push({ engine, cwd })
  const pending = engine.runTurn('respond', [])
  await started
  await vi.advanceTimersByTimeAsync(200_001)
  expect((await pending).result.status).toBe('completed')
  expect(displayed.join('')).toBe('ready')
})
