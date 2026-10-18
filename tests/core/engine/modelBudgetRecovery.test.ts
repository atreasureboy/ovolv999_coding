import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import OpenAI from 'openai'
import { afterEach, expect, it } from 'vitest'
import { ExecutionEngine, type EngineObserver } from '../../../src/core/engine.js'
import { createModelGateway } from '../../../src/core/modelGateway.js'
import { formatBudgetSummary, getBudgetPath, getUsage, resetUsage, reserveModelBudget, setBudget } from '../../../src/core/budget.js'
import { UsageLedger } from '../../../src/core/usageLedger.js'
import { vi } from 'vitest'
import { maybeCompact } from '../../../src/core/compact.js'
import type { EngineConfig, OpenAIMessage } from '../../../src/core/types.js'
import type { ModelProtocol } from '../../../src/core/model/types.js'
import { httpEvents } from '../../../src/core/model/transport.js'
import { execFileSync, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { getWorktreeManager } from '../../../src/tools/worktree.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(protocol: ModelProtocol = 'chat-completions', handler?: (response: ServerResponse, attempt: number) => boolean, usage = true) {
  const requests: Record<string, unknown>[] = []
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-budget-recovery-'))
  const runtime = mkdtempSync(join(tmpdir(), 'ovo-budget-runtime-'))
  process.env.OVOGO_STATE_DIR = runtime
  const server = createServer((request, response) => {
    let data = ''
    request.on('data', chunk => { data += String(chunk) })
    request.on('end', () => {
      const body = JSON.parse(data) as Record<string, unknown>
      requests.push(body)
      if (handler?.(response, requests.length)) return
      const output = (body.max_tokens ?? body.max_output_tokens) === 4000 ? '<summary>Requirements retained.</summary>' : 'ready'
      if (protocol === 'chat-completions' && !body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output } }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5 } } : {}) }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`)
      if (protocol === 'responses') {
        emit({ type: 'response.output_text.delta', delta: output })
        emit({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }], ...(usage ? { usage: { input_tokens: 10, output_tokens: 5 } } : {}) } })
      } else if (protocol === 'anthropic') {
        emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: output } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
        emit({ type: 'message_stop' })
      } else {
        emit({ choices: [{ index: 0, delta: { content: output }, finish_reason: 'stop' }] })
        if (usage) emit({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
        response.write('data: [DONE]\n\n')
      }
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture unavailable')
  const config: EngineConfig = { cwd, apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${address.port}/v1`, model: 'fixture-model', modelProtocol: protocol, maxContextTokens: 16000, maxOutputTokens: 100, maxIterations: 1, enabledModules: [], permissionMode: 'deny', agent: { identity: { systemPrompt: () => 'Requirements' }, tools: [] }, modelGateway: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 } }
  const engine = new ExecutionEngine(config, new Proxy({}, { get: () => () => undefined }) as EngineObserver)
  const client = () => createModelGateway(new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }), config, () => null)
  cleanups.push(async () => { await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }); rmSync(runtime, { recursive: true, force: true }) })
  return { cwd, engine, requests, config, client }
}

const params = { model: 'fixture-model', messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 100 }
const history: OpenAIMessage[] = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `history ${index}` }))

it.each(['chat-completions', 'responses', 'anthropic'] as const)('automatically counts and blocks real %s engine calls at the request cap', async protocol => {
  const f = await fixture(protocol)
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const first = await f.engine.runTurn('First', [])
  expect(first.result.status, first.result.output).toBe('completed')
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(1)
  const second = await f.engine.runTurn('Second', first.newHistory)
  expect(second.result.status).toBe('failed')
  expect(second.result.output).toMatch(/budget/i)
  expect(f.requests).toHaveLength(1)
})

it('reserves the project request cap across independent concurrent clients', async () => {
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await fixture('chat-completions', response => {
    finish = () => { response.writeHead(503); response.end('failed') }
    started()
    return true
  })
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const first = f.client().chat.completions.create(params).catch(error => error as Error)
  await ready
  try { await expect(f.client().chat.completions.create(params)).rejects.toThrow(/budget/i) } finally { finish() }
  expect((await first as Error).message).toMatch(/budget/i)
  expect(f.requests).toHaveLength(1)
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(1)
})

it('keeps a real delegated worktree request inside the originating project budget', async () => {
  const f = await fixture('chat-completions', (response, attempt) => {
    if (attempt !== 1) return false
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'delegate', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: 'Read isolated workspace', prompt: 'Report ready', worktree: 'budget-child', max_iterations: 1, subagent_type: 'explore' }) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
    return true
  })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe' })
  git('init')
  git('config', 'user.name', 'Budget fixture')
  git('config', 'user.email', 'budget@example.test')
  git('commit', '--allow-empty', '-m', 'fixture')
  const worktree = getWorktreeManager(f.cwd).createWorktree('budget-child')
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const observer = new Proxy({}, { get: () => () => undefined }) as EngineObserver
  let childConfig: EngineConfig | undefined
  let childOutput = ''
  const parent = new ExecutionEngine({ ...f.config, permissionMode: 'auto', agent: { identity: { systemPrompt: () => 'Delegate once' }, tools: ['Agent'] }, agentFactory(config, renderer) {
    childConfig = config
    const child = new ExecutionEngine(config, renderer as EngineObserver)
    return { abort: () => child.abort(), dispose: () => child.dispose(), async runTurn(prompt, messages) {
      const result = await child.runTurn(prompt, messages)
      childOutput = result.result.output
      return result
    } }
  } }, observer)
  try {
    await parent.runTurn('Delegate to the isolated worktree', [])
    expect(childConfig?.cwd).toBe(worktree.path)
    expect(childOutput).toMatch(/budget/i)
    expect(f.requests).toHaveLength(1)
    expect(getUsage(f.cwd, 'cap')?.spent).toBe(1)
    expect(getUsage(worktree.path, 'cap')).toBeNull()
  } finally { await parent.dispose() }
})

it('enforces one durable admission across concurrent independent Node processes', async () => {
  let finishRequest!: () => void
  let requestStarted!: () => void
  const requestReady = new Promise<void>(resolve => { requestStarted = resolve })
  const f = await fixture('chat-completions', response => {
    finishRequest = () => {
      if (response.writableEnded) return
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ready' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    }
    requestStarted()
    return true
  })
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const children = Array.from({ length: 2 }, () => {
    const child = fork(fileURLToPath(new URL('../../fixtures/model-budget-request.mjs', import.meta.url)), [f.cwd, f.config.baseURL!], { execArgv: ['--import', 'tsx'], silent: true })
    let stderr = ''
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    let ready!: () => void
    let finish!: (value: { completed?: boolean; error?: string }) => void
    const started = new Promise<void>(resolve => { ready = resolve })
    const result = new Promise<{ completed?: boolean; error?: string }>(resolve => { finish = resolve })
    const exited = new Promise<number | null>(resolve => child.once('exit', resolve))
    child.on('message', (message: { ready?: boolean; completed?: boolean; error?: string }) => message.ready ? ready() : finish(message))
    child.once('error', error => { ready(); finish({ error: error.message }) })
    child.once('exit', code => { ready(); if (code !== 0) finish({ error: `Child exited ${code}: ${stderr}` }) })
    return { child, started, result, exited, stderr: () => stderr }
  })
  try {
    await Promise.all(children.map(child => child.started))
    expect(children.every(entry => entry.child.connected), children.map(entry => entry.stderr()).join('\n')).toBe(true)
    children[0].child.send('start')
    await requestReady
    children[1].child.send('start')
    expect((await children[1].result).error).toMatch(/budget/i)
    finishRequest()
    const results = await Promise.all(children.map(child => child.result))
    expect(results.filter(result => result.completed), JSON.stringify(results)).toHaveLength(1)
    expect(results.find(result => result.error)?.error).toMatch(/budget|persistence lock is busy/i)
    expect(f.requests).toHaveLength(1)
    expect(getUsage(f.cwd, 'cap')?.spent).toBe(1)
    expect(await Promise.all(children.map(child => child.exited))).toEqual([0, 0])
  } finally {
    finishRequest?.()
    for (const { child } of children) if (child.exitCode === null) child.kill()
    await Promise.all(children.map(child => child.exited))
  }
}, 15000)

it('reserves token capacity while a request is pending and refunds unused capacity after actual usage', async () => {
  let finish!: () => void
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const f = await fixture('chat-completions', (response, attempt) => {
    if (attempt !== 1) return false
    finish = () => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ready' } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
    }
    started()
    return true
  })
  setBudget(f.cwd, { name: 'tokens', type: 'tokens', period: 'daily', limit: 32200 })
  const first = f.client().chat.completions.create(params)
  await ready
  await f.client().chat.completions.create(params)
  expect(getUsage(f.cwd, 'tokens')).toMatchObject({ spent: 16115, reserved: 16100 })
  try { await expect(f.client().chat.completions.create(params)).rejects.toThrow(/budget/i) } finally { finish() }
  await first
  expect(getUsage(f.cwd, 'tokens')).toMatchObject({ spent: 30, reserved: 0 })
  await f.client().chat.completions.create(params)
  expect(f.requests).toHaveLength(3)
  expect(getUsage(f.cwd, 'tokens')).toMatchObject({ spent: 45, reserved: 0 })
})

it('reports conservative advisory cost when pricing is unknown without blocking dispatch', async () => {
  const f = await fixture()
  setBudget(f.cwd, { name: 'cost', type: 'cost', period: 'daily', limit: 1, enforced: false })
  await f.client().chat.completions.create(params)
  await f.client().chat.completions.create(params)
  expect(f.requests).toHaveLength(2)
  expect(getUsage(f.cwd, 'cost')).toMatchObject({ spent: 2, conservative: 2, reserved: 0 })
  expect(formatBudgetSummary(f.cwd)).toContain('conservatively charged')
})

it.each([
  { cachedInputTokens: 11 },
  { cachedInputTokens: -1 },
  { cachedInputTokens: 6, cacheWriteTokens: 6 },
  { cacheWriteTokens: 0.5 },
  { reasoningTokens: 6 },
  { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
])('retains token and cost reservations for inconsistent actual usage %j', async invalid => {
  const f = await fixture()
  setBudget(f.cwd, { name: 'tokens', type: 'tokens', period: 'daily', limit: 20000 })
  setBudget(f.cwd, { name: 'cost', type: 'cost', period: 'daily', limit: 1 })
  const reservation = reserveModelBudget(f.cwd, 'invalid-usage', 16000, 100, { version: 'fixture', inputPer1M: 2, outputPer1M: 6, cachedInputPer1M: 1, cacheWritePer1M: 3 })
  reservation.settle({ kind: 'actual', inputTokens: 10, outputTokens: 5, ...invalid }, true)
  expect(getUsage(f.cwd, 'tokens')).toMatchObject({ spent: 16100, conservative: 16100, reserved: 0 })
  expect(getUsage(f.cwd, 'cost')?.spent).toBeCloseTo(0.0966)
  expect(getUsage(f.cwd, 'cost')?.conservative).toBeCloseTo(0.0966)
})

it('counts auxiliary compaction and every failed retry against the same request budget', async () => {
  const f = await fixture('responses', (response, attempt) => {
    if (attempt !== 2) return false
    response.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '0' })
    response.end('{"error":{"message":"temporary"}}')
    return true
  })
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 2 })
  expect((await f.engine.runTurn('First', [])).result.status).toBe('completed')
  expect((await maybeCompact(f.engine.getModelClient(), f.engine.getModel(), history)).compacted).toBe(false)
  expect(f.requests).toHaveLength(2)
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(2)
})

it('settles actual token and explicit pricing counters automatically', async () => {
  const f = await fixture()
  f.config.modelSettings = { 'fixture-model': { pricing: { version: 'fixture', inputPer1M: 2, outputPer1M: 6 } } }
  setBudget(f.cwd, { name: 'tokens', type: 'tokens', period: 'daily', limit: 40000 })
  setBudget(f.cwd, { name: 'cost', type: 'cost', period: 'daily', limit: 1 })
  await f.client().chat.completions.create(params)
  expect(getUsage(f.cwd, 'tokens')?.spent).toBe(15)
  expect(getUsage(f.cwd, 'cost')?.spent).toBeCloseTo(0.00005)
})

it('retains the full reservation when a successful provider omits usage', async () => {
  const f = await fixture('chat-completions', undefined, false)
  setBudget(f.cwd, { name: 'tokens', type: 'tokens', period: 'daily', limit: 16100 })
  await f.client().chat.completions.create(params)
  expect(getUsage(f.cwd, 'tokens')?.spent).toBe(16100)
  expect(formatBudgetSummary(f.cwd)).toContain('conservatively charged')
  await expect(f.client().chat.completions.create(params)).rejects.toThrow(/budget/i)
  expect(f.requests).toHaveLength(1)
})

it('rejects unknown model prices before dispatch under an enforced cost budget', async () => {
  const f = await fixture()
  setBudget(f.cwd, { name: 'cost', type: 'cost', period: 'daily', limit: 1 })
  await expect(f.client().chat.completions.create(params)).rejects.toThrow(/price|pricing/i)
  expect(f.requests).toHaveLength(0)
})

it('fails closed on damaged budget persistence', async () => {
  const f = await fixture()
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  writeFileSync(getBudgetPath(f.cwd), '{broken')
  await expect(f.client().chat.completions.create(params)).rejects.toThrow(/budget/i)
  expect(f.requests).toHaveLength(0)
})

it.each(['chat-completions', 'responses', 'anthropic'] as const)('recovers actual %s HTTP context overflow through compaction and retry', async protocol => {
  const f = await fixture(protocol, (response, attempt) => {
    if (attempt !== 1) return false
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded; fixture-secret authorization: Bearer private-secret' } }))
    return true
  })
  const result = await f.engine.runTurn('Continue', history)
  expect(result.result.status, result.result.output).toBe('completed')
  expect(f.requests).toHaveLength(3)
  expect(f.requests[1].max_tokens ?? f.requests[1].max_output_tokens).toBe(4000)
  expect(JSON.stringify(f.requests[2])).toContain('Requirements retained')
})

it('bounds and cancels HTTP error bodies and exposes only a safe context classification', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'fixture-secret password=other-secret' } }))); }, cancel() { cancelled = true } })
  const events = httpEvents('responses', {}, { capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: false, contextWindow: 16000, maxOutputTokens: 100 }, apiKey: 'fixture-secret', fetch: () => Promise.resolve(new Response(stream, { status: 400 })) }, new AbortController().signal)
  const error = await events.next().catch(value => value as Error & { code: string })
  expect(error).toMatchObject({ code: 'context_length_exceeded' })
  expect((error as Error).message).toContain('context length exceeded')
  expect((error as Error).message).not.toMatch(/fixture-secret|other-secret/)
  expect(cancelled).toBe(true)
}, 2000)

it('releases an undispatched project reservation when usage admission fails', async () => {
  const f = await fixture()
  const ledger = new UsageLedger()
  f.config.usageLedger = ledger
  vi.spyOn(ledger, 'beginUsage').mockImplementationOnce(() => { throw new Error('Fixture usage storage unavailable') })
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const client = f.client()
  await expect(client.chat.completions.create(params)).rejects.toThrow(/storage unavailable/i)
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(0)
  await client.chat.completions.create(params)
  expect(f.requests).toHaveLength(1)
})

it('keeps a cancelled stream charged conservatively and releases its pending reservation', async () => {
  const f = await fixture('chat-completions', response => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write('data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n')
    return true
  })
  setBudget(f.cwd, { name: 'tokens', type: 'tokens', period: 'daily', limit: 16100 })
  const controller = new AbortController()
  const stream = await f.client().chat.completions.create({ ...params, stream: true }, { signal: controller.signal })
  const iterator = stream[Symbol.asyncIterator]()
  await iterator.next()
  expect(formatBudgetSummary(f.cwd)).toContain('reserved pending settlement')
  controller.abort()
  await expect(iterator.next()).rejects.toThrow()
  expect(getUsage(f.cwd, 'tokens')?.spent).toBe(16100)
  expect(formatBudgetSummary(f.cwd)).toContain('conservatively charged')
  expect(resetUsage(f.cwd, 'tokens')).toBe(true)
  expect(getUsage(f.cwd, 'tokens')?.spent).toBe(0)
})

it('preserves pending reservations across reload and refuses reset bypass', async () => {
  const f = await fixture()
  setBudget(f.cwd, { name: 'cap', type: 'requests', period: 'daily', limit: 1 })
  const reservation = reserveModelBudget(f.cwd, 'pending-fixture', 16000, 100, null)
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(1)
  expect(() => resetUsage(f.cwd, 'cap')).toThrow(/pending/i)
  await expect(f.client().chat.completions.create(params)).rejects.toThrow(/budget/i)
  expect(f.requests).toHaveLength(0)
  reservation.settle({ kind: 'unknown' }, false)
  expect(getUsage(f.cwd, 'cap')?.spent).toBe(0)
})

it('bounds oversized and stalled provider error bodies without leaking raw text', async () => {
  for (const oversized of [false, true]) {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({ start(controller) { if (oversized) controller.enqueue(new TextEncoder().encode('private-secret'.repeat(2000))) }, cancel() { cancelled = true } })
    const started = performance.now()
    const events = httpEvents('anthropic', {}, { capabilities: { tools: true, vision: false, reasoning: false, structuredOutput: false, contextWindow: 16000, maxOutputTokens: 100 }, fetch: () => Promise.resolve(new Response(body, { status: 503 })) }, new AbortController().signal)
    await expect(events.next()).rejects.toThrow('Model request failed (HTTP 503)')
    expect(performance.now() - started).toBeLessThan(1000)
    expect(cancelled).toBe(true)
  }
})
