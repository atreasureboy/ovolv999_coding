import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'

const fixtures: Array<{ engine: ExecutionEngine; server: Server; cwd: string }> = []
afterEach(async () => { for (const { engine, server, cwd } of fixtures.splice(0)) { await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }) } })

async function setup(fixtureEvents?: Record<string, unknown>[]) {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const server = createServer((req, res) => {
    let data = ''
    req.on('data', chunk => { data += String(chunk) })
    req.on('end', () => {
      requests.push({ path: req.url!, body: JSON.parse(data) as Record<string, unknown> })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const output = [{ type: 'reasoning', id: 'reasoning-fixture', encrypted_content: 'opaque-fixture', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] }]
      for (const event of fixtureEvents ?? [{ type: 'response.output_text.delta', delta: 'ready' }, { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 5 } } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-native-gateway-'))
  const engine = new ExecutionEngine({ cwd, apiKey: 'fixture-key', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'native', modelProtocol: 'responses', modelSettings: { native: { capabilities: { reasoning: true, contextWindow: 64000, maxOutputTokens: 8192 }, effort: { parameter: 'reasoning.effort', values: { medium: 'medium', high: 'high' } } } }, maxIterations: 1, permissionMode: 'deny', enabledModules: [], agent: { identity: { systemPrompt: () => 'project requirements' }, tools: [] } }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver)
  fixtures.push({ engine, server, cwd })
  return { engine, requests }
}

it('sends native effort through the real engine and keeps continuation after an effort change', async () => {
  const { engine, requests } = await setup()
  engine.setEffort('high')
  const first = await engine.runTurn('first', [])
  expect(requests[0].path).toBe('/v1/responses')
  expect(requests[0].body.reasoning).toEqual({ effort: 'high' })
  expect(first.result.status).toBe('completed')
  expect(first.newHistory.find(message => message.role === 'assistant')?.providerState).toBeDefined()
  engine.setEffort('medium')
  const second = await engine.runTurn('second', JSON.parse(JSON.stringify(first.newHistory)))
  expect(second.result.status).toBe('completed')
  expect(requests[1].body.reasoning).toEqual({ effort: 'medium' })
  expect(requests[1].body.input).toContainEqual({ type: 'reasoning', id: 'reasoning-fixture', encrypted_content: 'opaque-fixture', summary: [] })
  expect(engine.getCostTracker().getTotalAPICalls()).toBe(2)
})

it('routes non-streaming auxiliary requests through the same native gateway and ledger', async () => {
  const { engine, requests } = await setup()
  await engine.runTurn('primary', [])
  const result = await engine.getModelClient().chat.completions.create({ model: 'native', messages: [{ role: 'user', content: 'compact helper' }], max_tokens: 32 })
  expect(result.choices[0].message.content).toBe('ready')
  expect(requests.map(request => request.path)).toEqual(['/v1/responses', '/v1/responses'])
  expect(engine.getCostTracker().getTotalAPICalls()).toBe(2)
})

it('starts a fresh native continuation after explicitly trimming history', async () => {
  const { engine, requests } = await setup()
  const first = await engine.runTurn('first', [])
  engine.queueSnip(2)
  const second = await engine.runTurn('second', first.newHistory)
  expect(second.result.status).toBe('completed')
  expect(requests).toHaveLength(2)
  expect(requests[1].body.input).not.toContainEqual(expect.objectContaining({ type: 'reasoning' }))
  expect(first.newHistory.find(message => message.role === 'assistant')?.providerState).toBeDefined()
})

it.each([false, true])('retains reported usage and never replays a partial native response (stream=%s)', async stream => {
  const { engine, requests } = await setup([
    { type: 'response.output_text.delta', delta: 'partial' },
    { type: 'response.failed', response: { usage: { input_tokens: 100, output_tokens: 10 }, error: { code: 'server_error', message: 'synthetic failure after partial output' } } },
  ])
  await expect((async () => {
    if (stream) {
      const response = await engine.getModelClient().chat.completions.create({ model: 'native', messages: [{ role: 'user', content: 'helper' }], max_tokens: 32, stream: true })
      for await (const _chunk of response) void _chunk
    } else await engine.getModelClient().chat.completions.create({ model: 'native', messages: [{ role: 'user', content: 'helper' }], max_tokens: 32 })
  })()).rejects.toThrow(/synthetic failure/)
  expect(requests).toHaveLength(1)
  expect(engine.getCostTracker().getUsageSummary()).toMatchObject({ requestCount: 1, actualRequestCount: 1, unknownRequestCount: 0, inputTokens: 100, outputTokens: 10 })
})
