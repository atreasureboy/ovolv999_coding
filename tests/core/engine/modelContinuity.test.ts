import { createServer, type ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ExecutionEngine, type EngineObserver } from '../../../src/core/engine.js'
import { maybeCompact } from '../../../src/core/compact.js'
import { SemanticMemory } from '../../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../../src/core/episodicMemory.js'
import type { EngineConfig, OpenAIMessage } from '../../../src/core/types.js'
import type { ModelProtocol, ProviderContinuationState } from '../../../src/core/model/types.js'
import { CriticModule } from '../../../src/modules/critic.js'
import { ReflectionModule, consolidateSession } from '../../../src/modules/reflection.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })

async function fixture(protocol: ModelProtocol, thinking = false) {
  const requests: Record<string, unknown>[] = []
  let intercept: ((body: Record<string, unknown>, response: ServerResponse) => boolean) | undefined
  const server = createServer((request, response) => {
    let data = ''
    request.on('data', chunk => { data += String(chunk) })
    request.on('end', () => {
      const body = JSON.parse(data) as Record<string, unknown>
      requests.push(body)
      if (intercept?.(body, response)) return
      const limit = body.max_tokens ?? body.max_output_tokens
      const output = limit === 4000 ? '<summary>Retain the agreed project requirements.</summary>'
        : limit === 400 ? '[ISSUE] Verification was skipped. [FIX] Run verification.'
          : limit === 800 ? JSON.stringify({ knowledge: [{ content: 'Verify generated changes before accepting completion', tags: ['verification'], confidence: 0.8 }] }) : 'ready'
      if (protocol === 'chat-completions' && !body.stream) {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: output } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }))
        return
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const emit = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`)
      if (protocol === 'anthropic') {
        emit({ type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } })
        emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: output } })
        emit({ type: 'content_block_stop', index: 0 })
        emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
        emit({ type: 'message_stop' })
      } else if (protocol === 'responses') {
        emit({ type: 'response.output_text.delta', delta: output })
        emit({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'reasoning-fixture', encrypted_content: 'opaque-fixture', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: output }] }], usage: { input_tokens: 10, output_tokens: 5 } } })
      } else {
        emit({ choices: [{ index: 0, delta: { content: output, reasoning_content: 'opaque-fixture' }, finish_reason: 'stop' }] })
        emit({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })
        response.write('data: [DONE]\n\n')
      }
      response.end()
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-model-continuity-'))
  const config: EngineConfig = {
    cwd, model: 'model-a', apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`,
    modelProtocol: protocol, maxIterations: 1, maxOutputTokens: 8192, maxContextTokens: 64000,
    modelSettings: thinking ? { 'model-a': { capabilities: { reasoning: true }, effort: { parameter: 'thinking.budget_tokens', values: { medium: 4096 } } } } : undefined,
    permissionMode: 'deny', enabledModules: [], agent: { identity: { systemPrompt: () => 'Project requirements' }, tools: [] },
  }
  const engine = new ExecutionEngine(config, new Proxy({}, { get: () => () => undefined }) as EngineObserver)
  cleanups.push(async () => { await engine.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(cwd, { recursive: true, force: true }) })
  return { engine, requests, cwd, intercept: (handler: typeof intercept) => { intercept = handler } }
}

function toolHistory(): OpenAIMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: 'kept-call', type: 'function', function: { name: 'Read', arguments: '{"path":"file.ts"}' } }] },
    { role: 'tool', tool_call_id: 'kept-call', name: 'Read', content: 'retained tool result' },
    { role: 'assistant', content: 'Read completed' },
  ]
}

it('applies an explicit provider and protocol change to the existing client without forwarding old native state', async () => {
  const source = await fixture('responses')
  const destination = await fixture('chat-completions')
  const first = await source.engine.runTurn('Keep this visible history', [])
  const previousClient = source.engine.getModelClient()
  source.engine.applyRuntimeConfiguration({ baseURL: destination.engine.getConfig().baseURL, modelProtocol: 'chat-completions', apiKey: 'replacement-fixture', temperature: 0.3 })
  const second = await source.engine.runTurn('Continue at the new endpoint', first.newHistory)
  expect(second.result.status, second.result.output).toBe('completed')
  expect(source.requests).toHaveLength(1)
  expect(destination.requests).toHaveLength(1)
  expect(destination.requests[0]).toMatchObject({ model: 'model-a', temperature: 0.3 })
  expect(JSON.stringify(destination.requests[0])).toContain('Keep this visible history')
  expect(JSON.stringify(destination.requests[0])).not.toContain('opaque-fixture')
  expect(source.engine.getModelClient()).toBe(previousClient)
  const compacted = await maybeCompact(previousClient, source.engine.getModel(), compactHistory())
  expect(compacted.compacted).toBe(true)
  expect(destination.requests).toHaveLength(2)
})

it('rejects a tampered history when explicitly switching provider with the same model name', async () => {
  const source = await fixture('responses')
  const destination = await fixture('responses')
  const first = await source.engine.runTurn('Original instruction', [])
  const history = structuredClone(first.newHistory)
  history[0].content = 'Tampered instruction'
  source.engine.applyRuntimeConfiguration({ baseURL: destination.engine.getConfig().baseURL })
  const next = await source.engine.runTurn('Continue', history)
  expect(next.result.status).toBe('failed')
  expect(next.result.output).toMatch(/continuation/i)
  expect(destination.requests).toHaveLength(0)
})

it('refreshes session instructions before the next real model request', async () => {
  const { engine, requests, cwd } = await fixture('chat-completions')
  let current = 'first-mode-sentinel'
  engine.getConfig().sessionDir = cwd
  engine.getConfig().sessionSystemPrompt = () => current
  const first = await engine.runTurn('First', [])
  current = 'second-mode-sentinel'
  await engine.runTurn('Second', first.newHistory)
  expect(JSON.stringify(requests[0])).toContain('first-mode-sentinel')
  expect(JSON.stringify(requests[1])).toContain('second-mode-sentinel')
  expect(JSON.stringify(requests[1])).not.toContain('first-mode-sentinel')
})

function compactHistory(): OpenAIMessage[] {
  return [...Array.from({ length: 17 }, (_, index): OpenAIMessage => ({ role: index % 2 ? 'assistant' : 'user', content: `history ${index}` })), ...toolHistory(),
    { role: 'user', content: 'Continue the project' }, { role: 'assistant', content: 'Continuing' }]
}

it.each(['chat-completions', 'responses', 'anthropic'] as const)('continues %s after summary compaction while preserving recent tool pairs', async protocol => {
  const { engine, requests } = await fixture(protocol)
  const initial = await engine.runTurn('Before summary', compactHistory())
  expect(initial.result.status).toBe('completed')
  const history: OpenAIMessage[] = [...initial.newHistory, { role: 'assistant', content: 'Additional visible context' }]
  const snapshot = structuredClone(history)
  const compacted = await maybeCompact(engine.getModelClient(), engine.getModel(), history)
  expect(compacted.compacted).toBe(true)
  const next = await engine.runTurn('Continue from the summary', compacted.messages)
  expect(next.result.status).toBe('completed')
  expect(requests).toHaveLength(3)
  expect(JSON.stringify(requests[2])).toContain('Retain the agreed project requirements.')
  expect(JSON.stringify(requests[2])).toContain('kept-call')
  expect(JSON.stringify(requests[2])).toContain('retained tool result')
  expect(history).toEqual(snapshot)
})

it('summarizes with an auxiliary thinking policy while preserving the main thinking budget', async () => {
  const { engine, requests } = await fixture('anthropic', true)
  expect((await engine.runTurn('First', [])).result.status).toBe('completed')
  const compacted = await maybeCompact(engine.getModelClient(), engine.getModel(), compactHistory())
  expect(compacted.compacted).toBe(true)
  expect((await engine.runTurn('Next', compacted.messages)).result.status).toBe('completed')
  expect(requests.map(request => request.thinking)).toEqual([{ type: 'enabled', budget_tokens: 4096 }, undefined, { type: 'enabled', budget_tokens: 4096 }])
  expect(requests[1].max_tokens).toBe(4000)
})

it('runs the real critic at its small output budget under a thinking model', async () => {
  const { engine, requests } = await fixture('anthropic', true)
  const critic = new CriticModule(engine.getModelClient(), engine.getModel(), {})
  const result = await critic.onIteration({ iteration: 5, messages: compactHistory(), abortSignal: new AbortController().signal })
  expect(result?.injectMessage).toContain('Run verification')
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ max_tokens: 400 })
  expect(requests[0].thinking).toBeUndefined()
})

it('persists run and session reflection under a thinking model at the reflection output budget', async () => {
  const { engine, requests, cwd } = await fixture('anthropic', true)
  const semantic = new SemanticMemory(cwd)
  const reflection = new ReflectionModule(engine.getModelClient(), engine.getModel(), semantic, {})
  await reflection.onComplete({ cwd, messages: [...toolHistory(), ...toolHistory(), ...toolHistory()], turnResult: { stopped: true, reason: 'error', status: 'failed', output: 'Build failed' } })
  expect(semantic.readAll()).toHaveLength(1)
  const episodic = new EpisodicMemory(cwd)
  for (let turn = 0; turn < 5; turn++) await episodic.writeAsync({ turn, toolName: 'Read', inputSummary: 'file', resultSummary: 'text', outcome: 'success', timestamp: new Date().toISOString() })
  expect(await consolidateSession(engine.getModelClient(), engine.getModel(), episodic, semantic)).toMatchObject({ episodes: 5, knowledgeExtracted: 1 })
  expect(requests).toHaveLength(2)
  expect(requests.every(request => request.max_tokens === 800 && request.thinking === undefined)).toBe(true)
})

it.each(['chat-completions', 'responses', 'anthropic'] as const)('rebuilds %s continuation on explicit model changes without losing visible history or tool results', async protocol => {
  const { engine, requests } = await fixture(protocol)
  const first = await engine.runTurn('First', [])
  const history = [...first.newHistory, ...toolHistory()]
  const snapshot = structuredClone(history)
  engine.setModel('model-b')
  const second = await engine.runTurn('Second', history)
  expect(second.result.status).toBe('completed')
  expect(requests[1].model).toBe('model-b')
  expect(JSON.stringify(requests[1])).not.toContain('opaque-fixture')
  expect(JSON.stringify(requests[1])).toContain('First')
  expect(JSON.stringify(requests[1])).toContain('retained tool result')
  expect(history).toEqual(snapshot)
  expect((await engine.runTurn('Third', second.newHistory)).result.status).toBe('completed')
  engine.setModel('model-c')
  expect((await engine.runTurn('Fourth', second.newHistory)).result.status).toBe('completed')
  expect(requests[3].model).toBe('model-c')
})

it.each(['same-model', 'changed-history', 'changed-protocol', 'changed-provider'] as const)('rejects corrupt continuation after %s instead of laundering it through a model switch', async corruption => {
  const { engine, requests } = await fixture('responses')
  const first = await engine.runTurn('First', [])
  const history = structuredClone(first.newHistory)
  const state = history.find(message => message.providerState)?.providerState as ProviderContinuationState
  if (corruption === 'changed-history') history[0].content = 'Tampered original question'
  else if (corruption === 'changed-protocol') state.protocol = 'anthropic'
  else if (corruption === 'changed-provider') state.provider = 'untrusted-provider'
  else state.turns = []
  engine.setModel(corruption === 'same-model' ? 'model-a' : 'model-b')
  const next = await engine.runTurn('Next', history)
  expect(next.result.status).toBe('failed')
  expect(next.result.output).toMatch(/continuation/i)
  expect(requests).toHaveLength(1)
})

it('continues from a cancelled first request after changing models', async () => {
  const { engine, requests, intercept } = await fixture('responses')
  const first = await engine.runTurn('First', [])
  engine.setModel('model-b')
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  intercept(() => { started(); return true })
  const pending = engine.runTurn('Cancelled', first.newHistory)
  await Promise.race([requestStarted, pending.then(result => { throw new Error(`Request never started: ${result.result.output}`) })])
  engine.abort()
  const cancelled = await pending
  expect(cancelled.result.status).toBe('cancelled')
  intercept(undefined)
  const resumed = await engine.runTurn('Resume', cancelled.newHistory)
  expect(resumed.result.status).toBe('completed')
  expect(requests[2].model).toBe('model-b')
  expect(JSON.stringify(requests[2])).not.toContain('opaque-fixture')
})

it('continues after a failed migrated request and successive changes before another request', async () => {
  const { engine, requests, intercept } = await fixture('responses')
  const first = await engine.runTurn('First', [])
  engine.setModel('model-b')
  engine.setModel('model-c')
  intercept((_body, response) => {
    response.writeHead(400, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Fixture rejected request' } }))
    return true
  })
  const failed = await engine.runTurn('Failed', first.newHistory)
  expect(failed.result.status).toBe('failed')
  expect(requests[1].model).toBe('model-c')
  intercept(undefined)
  engine.setModel('model-d')
  expect((await engine.runTurn('Recovered', failed.newHistory)).result.status).toBe('completed')
  expect(requests[2].model).toBe('model-d')
  expect(JSON.stringify(requests[2])).not.toContain('opaque-fixture')
})

it('still validates the new model continuation after a successful migration', async () => {
  const { engine, requests } = await fixture('responses')
  const first = await engine.runTurn('First', [])
  engine.setModel('model-b')
  const second = await engine.runTurn('Second', first.newHistory)
  expect(second.result.status).toBe('completed')
  const state = second.newHistory.find(message => message.providerState)?.providerState as ProviderContinuationState
  state.turns = []
  const third = await engine.runTurn('Third', second.newHistory)
  expect(third.result.status).toBe('failed')
  expect(third.result.output).toMatch(/continuation/i)
  expect(requests).toHaveLength(2)
})

it('aborts an auxiliary thinking summary without replacing its original history', async () => {
  const { engine, requests, intercept } = await fixture('anthropic', true)
  const history = compactHistory()
  const snapshot = structuredClone(history)
  let started!: () => void
  const requestStarted = new Promise<void>(resolve => { started = resolve })
  intercept(() => { started(); return true })
  const controller = new AbortController()
  const pending = maybeCompact(engine.getModelClient(), engine.getModel(), history, controller.signal)
  const result = pending.then(value => ({ value }), error => ({ error: error as Error }))
  await Promise.race([requestStarted, result.then(() => { throw new Error('Summary ended before cancellation') })])
  controller.abort(new Error('Summary aborted'))
  expect(await result).toMatchObject({ error: expect.objectContaining({ message: expect.stringMatching(/abort/i) }) })
  expect(requests).toHaveLength(1)
  expect(history).toEqual(snapshot)
})
