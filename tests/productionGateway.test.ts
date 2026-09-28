import { afterEach, expect, it } from 'vitest'
import { createServer, type Server, type ServerResponse } from 'node:http'
import OpenAI from 'openai'
import { createModelGateway } from '../src/core/modelGateway.js'
import type { EngineConfig } from '../src/core/types.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

function response(res: ServerResponse, text = 'done'): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ id: 'local-response', object: 'chat.completion', created: 1, model: 'local-test', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }))
}

async function setup(handler: (res: ServerResponse, body: Record<string, unknown>, attempt: number) => void, policy: Record<string, number> = {}) {
  let requests = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => handler(res, JSON.parse(body) as Record<string, unknown>, ++requests))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local server address unavailable')
  const config: EngineConfig = {
    model: 'local-test', apiKey: 'local-fixture-only', baseURL: `http://127.0.0.1:${address.port}/v1`, cwd: process.cwd(), maxIterations: 1, permissionMode: 'deny',
    modelGateway: { baseDelayMs: 5, maxDelayMs: 10, deadlineMs: 1000, ...policy },
  }
  const events: Record<string, unknown>[] = []
  config.eventLog = { append: (_kind: string, _tool: string, data: Record<string, unknown>) => { events.push(data) } } as unknown as EngineConfig['eventLog']
  const client = createModelGateway(new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, maxRetries: 0 }), config, () => null)
  return { client, config, events, requests: () => requests }
}

const params = { model: 'local-test', messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 8 }
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('HTTP fixture did not reach expected barrier')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

it('retries local 429 and 503 responses within a bounded three-attempt budget', async () => {
  const test = await setup((res, _body, attempt) => {
    if (attempt < 3) { res.writeHead(attempt === 1 ? 429 : 503, { 'Content-Type': 'application/json', 'Retry-After': '0' }); res.end('{"error":{"message":"temporary"}}') }
    else response(res)
  })
  expect((await test.client.chat.completions.create(params)).choices[0].message.content).toBe('done')
  expect(test.requests()).toBe(3)
  expect(test.events).toContainEqual(expect.objectContaining({ usage: 'actual', input_tokens: 3, output_tokens: 2 }))
})

it('stops retries at the configured attempt budget', async () => {
  const test = await setup(res => { res.writeHead(503); res.end('unavailable') }, { maxAttempts: 2 })
  await expect(test.client.chat.completions.create(params)).rejects.toThrow()
  expect(test.requests()).toBe(2)
})

it('honors Retry-After without scheduling a retry beyond the request deadline', async () => {
  const test = await setup(res => { res.writeHead(429, { 'Retry-After': '5' }); res.end('rate limited') }, { deadlineMs: 100 })
  const started = performance.now()
  await expect(test.client.chat.completions.create(params)).rejects.toThrow()
  expect(test.requests()).toBe(1)
  expect(performance.now() - started).toBeLessThan(500)
})

it('never replays a stream after a real partial response and connection loss', async () => {
  const test = await setup(res => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"id":"chunk","choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')
    setTimeout(() => res.destroy(), 40)
  })
  const stream = await test.client.chat.completions.create({ ...params, stream: true })
  const chunks: string[] = []
  await expect((async () => { for await (const chunk of stream) chunks.push(chunk.choices[0]?.delta.content ?? '') })()).rejects.toThrow()
  expect(chunks).toEqual(['partial'])
  expect(test.requests()).toBe(1)
  expect(test.events).toContainEqual(expect.objectContaining({ usage: 'unknown', phase: 'stream_failed' }))
})

it('cancels a queued request and preserves FIFO order for surviving requests', async () => {
  let first: ServerResponse | undefined
  const order: string[] = []
  const test = await setup((res, body) => {
    const text = (body.messages as Array<{ content: string }>)[0].content
    order.push(text)
    if (text === 'first') first = res
    else response(res, text)
  }, { maxConcurrency: 1 })
  const one = test.client.chat.completions.create({ ...params, messages: [{ role: 'user', content: 'first' }] })
  await until(() => first !== undefined)
  const controller = new AbortController()
  const two = test.client.chat.completions.create({ ...params, messages: [{ role: 'user', content: 'second' }] }, { signal: controller.signal })
  const rejected = expect(two).rejects.toThrow()
  const three = test.client.chat.completions.create({ ...params, messages: [{ role: 'user', content: 'third' }] })
  controller.abort()
  await rejected
  response(first!)
  await one
  expect((await three).choices[0].message.content).toBe('third')
  expect(order).toEqual(['first', 'third'])
})

it('opens a provider circuit after repeated errors and permits a later recovery probe', async () => {
  const test = await setup((res, _body, attempt) => {
    if (attempt <= 2) { res.writeHead(503); res.end('failed') } else response(res)
  }, { maxAttempts: 1, circuitFailureThreshold: 2, circuitCooldownMs: 60 })
  await expect(test.client.chat.completions.create(params)).rejects.toThrow()
  await expect(test.client.chat.completions.create(params)).rejects.toThrow()
  await expect(test.client.chat.completions.create(params)).rejects.toThrow(/circuit/i)
  expect(test.requests()).toBe(2)
  await new Promise(resolve => setTimeout(resolve, 80))
  expect((await test.client.chat.completions.create(params)).choices[0].message.content).toBe('done')
})

it('rejects an over-budget request before any HTTP request is sent', async () => {
  const test = await setup(res => response(res), { maxRunTokens: 1 })
  await expect(test.client.chat.completions.create(params)).rejects.toThrow(/budget/i)
  expect(test.requests()).toBe(0)
})

it('retries an actual connection loss before response headers without relying on SDK retries', async () => {
  const test = await setup((res, _body, attempt) => { if (attempt === 1) res.destroy(); else response(res) })
  expect((await test.client.chat.completions.create(params)).choices[0].message.content).toBe('done')
  expect(test.requests()).toBe(2)
})

it('bounds the provider queue while a real request holds its concurrency slot', async () => {
  let first: ServerResponse | undefined
  const test = await setup((res, _body, attempt) => { if (attempt === 1) first = res; else response(res) }, { maxConcurrency: 1, maxQueue: 1 })
  const one = test.client.chat.completions.create(params)
  await until(() => first !== undefined)
  const two = test.client.chat.completions.create(params)
  await expect(test.client.chat.completions.create(params)).rejects.toThrow(/queue is full/)
  response(first!)
  await Promise.all([one, two])
  expect(test.requests()).toBe(2)
})

it('holds the concurrency slot until streaming ends and releases it when the consumer stops', async () => {
  const test = await setup((res, _body, attempt) => {
    if (attempt > 1) { response(res); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"id":"chunk","choices":[{"index":0,"delta":{"content":"first"}}]}\n\n')
  }, { maxConcurrency: 1 })
  const stream = await test.client.chat.completions.create({ ...params, stream: true })
  const iterator = stream[Symbol.asyncIterator]()
  expect((await iterator.next()).done).toBe(false)
  const pending = test.client.chat.completions.create(params)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(test.requests()).toBe(1)
  await iterator.return?.()
  expect((await pending).choices[0].message.content).toBe('done')
  expect(test.events).toContainEqual(expect.objectContaining({ phase: 'stream_abandoned', usage: 'unknown' }))
})

it('aborts an unconsumed stream at its deadline and lets the next request proceed', async () => {
  const test = await setup((res, _body, attempt) => {
    if (attempt > 1) { response(res); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"id":"chunk","choices":[{"index":0,"delta":{"content":"unused"}}]}\n\n')
  }, { maxConcurrency: 1, deadlineMs: 100 })
  await test.client.chat.completions.create({ ...params, stream: true })
  await new Promise(resolve => setTimeout(resolve, 120))
  expect((await test.client.chat.completions.create(params)).choices[0].message.content).toBe('done')
  expect(test.events).toContainEqual(expect.objectContaining({ phase: 'stream_aborted', usage: 'unknown' }))
})

it('waits for provider request-rate capacity and cancels the wait without sending', async () => {
  const test = await setup(res => response(res), { requestsPerMinute: 1, rateWindowMs: 100 })
  await test.client.chat.completions.create(params)
  const controller = new AbortController()
  const queued = test.client.chat.completions.create(params, { signal: controller.signal })
  const rejected = expect(queued).rejects.toThrow()
  controller.abort()
  await rejected
  expect(test.requests()).toBe(1)
  await new Promise(resolve => setTimeout(resolve, 110))
  await test.client.chat.completions.create(params)
  expect(test.requests()).toBe(2)
})

it('shares provider concurrency between independent gateway clients', async () => {
  let first: ServerResponse | undefined
  const test = await setup((res, _body, attempt) => { if (attempt === 1) first = res; else response(res) }, { maxConcurrency: 1 })
  const another = createModelGateway(new OpenAI({ apiKey: test.config.apiKey, baseURL: test.config.baseURL }), test.config, () => null)
  const one = test.client.chat.completions.create(params)
  await until(() => first !== undefined)
  const two = another.chat.completions.create(params)
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(test.requests()).toBe(1)
  response(first!)
  await Promise.all([one, two])
  expect(test.requests()).toBe(2)
})

it('validates policy bounds before starting a provider request', async () => {
  await expect(setup(res => response(res), { maxAttempts: 0 })).rejects.toThrow(/positive/)
})
