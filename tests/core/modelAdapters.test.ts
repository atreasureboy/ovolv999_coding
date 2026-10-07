import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { OpenAIMessage } from '../../src/core/types.js'
import type { ModelEvent, ModelRequest, ModelCapabilities, AdapterOptions } from '../../src/core/model/types.js'

const capabilities: ModelCapabilities = { tools: true, vision: true, reasoning: true, structuredOutput: true, contextWindow: 200000, maxOutputTokens: 32000 }
const tool = { type: 'function' as const, function: { name: 'Read', description: 'Read a file', parameters: { type: 'object' as const, properties: { path: { type: 'string' } }, required: ['path'] } } }
const request = (changes: Partial<ModelRequest> = {}): ModelRequest => ({ model: 'fixture-model', messages: [{ role: 'system', content: 'Follow workspace rules' }, { role: 'user', content: 'Read the file' }], tools: [tool], effort: 'medium', maxOutputTokens: 8192, ...changes })
const signal = (): AbortSignal => new AbortController().signal
const collect = async (events: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> => { const result: ModelEvent[] = []; for await (const event of events) result.push(event); return result }
const load = () => import('../../src/core/model/index.js')
const sse = (events: unknown[], ending = true): string => events.map(event => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') + (ending ? 'data: [DONE]\r\n\r\n' : '')
function transport(events: unknown[], chunks = 11) {
  const body = new TextEncoder().encode(sse(events))
  return vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) {
    for (let offset = 0; offset < body.length; offset += chunks) controller.enqueue(body.subarray(offset, offset + chunks))
    controller.close()
  } }), { headers: { 'content-type': 'text/event-stream' } })))
}
function sent(fetcher: ReturnType<typeof transport>, index = 0): Record<string, unknown> {
  const body = fetcher.mock.calls[index][1]?.body
  if (typeof body !== 'string') throw new Error('Expected a JSON request body')
  return JSON.parse(body) as Record<string, unknown>
}
function endpoint(fetcher: ReturnType<typeof transport>): string {
  const value = fetcher.mock.calls[0][0]
  return typeof value === 'string' ? value : value instanceof URL ? value.href : value.url
}
const responseOutput = [
  { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-reasoning' },
  { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Working', annotations: [] }] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'Read', arguments: '{"path":"a.ts"}', status: 'completed' },
]
const responseEvents = [
  { type: 'response.output_item.added', output_index: 0, item: responseOutput[0] },
  { type: 'response.reasoning_text.delta', delta: 'private raw reasoning' },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Work' },
  { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'ing' },
  { type: 'response.output_item.added', output_index: 2, item: { ...responseOutput[2], arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '{"path":' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 2, delta: '"a.ts"}' },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed', output: responseOutput, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30, output_tokens_details: { reasoning_tokens: 20 } } } },
]
const anthropicEvents = [
  { type: 'message_start', message: { id: 'msg_a', role: 'assistant', content: [], usage: { input_tokens: 60, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'private native thinking' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'native-signature' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Working' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'Read', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
  { type: 'message_stop' },
]
const following = (initial: readonly OpenAIMessage[]): OpenAIMessage[] => [...initial, { role: 'assistant', content: 'Working', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] }, { role: 'tool', tool_call_id: 'call_1', content: 'file content' }]

describe('native model adapters', () => {
  it.each([
    ['chat-completions', 'reasoning_content'],
    ['chat-completions', 'reasoning_details'],
    ['responses', 'response.reasoning_text.delta'],
    ['responses', 'response.reasoning_summary_text.delta'],
    ['anthropic', 'thinking_delta'],
    ['anthropic', 'signature_delta'],
  ] as const)('reports private %s %s activity without exposing its contents', async (protocol, kind) => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const deltas = ['private first', 'private second'].map(value => protocol === 'chat-completions'
      ? { choices: [{ delta: { [kind]: kind === 'reasoning_details' ? [{ type: 'reasoning.text', text: value }] : value } }] }
      : protocol === 'responses' ? { type: kind, delta: value }
        : { type: 'content_block_delta', index: 0, delta: { type: kind, [kind === 'thinking_delta' ? 'thinking' : 'signature']: value } })
    const input = protocol === 'anthropic' ? [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      ...deltas,
    ] : deltas
    const events = await collect(make({ fetch: transport(input), capabilities }).stream(request(), signal()))
    expect(events.filter(event => event.type === 'progress')).toEqual([{ type: 'progress' }, { type: 'progress' }])
    expect(JSON.stringify(events)).not.toContain('private')
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'incomplete_stream' })
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('reports filtered %s text activity across split thinking tags', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const chunks = ['<thi', 'nk>private ', 'more</thi', 'nk>visible']
    const input = protocol === 'chat-completions' ? [
      ...chunks.map(content => ({ choices: [{ delta: { content } }] })),
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ] : protocol === 'responses' ? [
      ...chunks.map(delta => ({ type: 'response.output_text.delta', delta })),
      { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: chunks.join('') }] }] } },
    ] : [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: chunks[0] } },
      ...chunks.slice(1).map(text => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]
    const events = await collect(make({ fetch: transport(input), capabilities }).stream(request(), signal()))
    expect(events.filter(event => event.type === 'progress')).toEqual([{ type: 'progress' }, { type: 'progress' }, { type: 'progress' }])
    expect(events.filter(event => event.type === 'textDelta')).toEqual([{ type: 'textDelta', text: 'visible' }])
    expect(JSON.stringify(events.filter(event => event.type !== 'completed'))).not.toContain('private')
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
  })

  it.each([
    ['chat-completions', 'reasoning_content'],
    ['chat-completions', 'reasoning_details'],
    ['responses', 'response.reasoning_text.delta'],
    ['responses', 'response.reasoning_summary_text.delta'],
    ['anthropic', 'thinking_delta'],
    ['anthropic', 'signature_delta'],
  ] as const)('rejects malformed %s %s before reporting activity', async (protocol, kind) => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const delta = protocol === 'chat-completions' ? { choices: [{ delta: { [kind]: 42 } }] }
      : protocol === 'responses' ? { type: kind, delta: 42 }
        : { type: 'content_block_delta', index: 0, delta: { type: kind, [kind === 'thinking_delta' ? 'thinking' : 'signature']: 42 } }
    const input = protocol === 'anthropic' ? [
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      delta,
    ] : [delta]
    const events = await collect(make({ fetch: transport(input), capabilities }).stream(request(), signal()))
    expect(events.some(event => event.type === 'progress')).toBe(false)
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream', retryable: false })
  })

  it('keeps Chat compatibility, actual usage, fragmented tool IDs and reasoning private', async () => {
    const { createChatCompletionsAdapter } = await load()
    const fetcher = transport([
      { choices: [{ delta: { content: 'Visible <thi' } }] },
      { choices: [{ delta: { content: 'nk>private</think> answer', reasoning_content: 'opaque chat reasoning', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 100, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 20 } } },
    ])
    const adapter = createChatCompletionsAdapter({ fetch: fetcher, apiKey: 'fixture-key', capabilities, effort: { parameter: 'reasoning_effort', values: { high: 'high' } } })
    const events = await collect(adapter.stream(request({ effort: 'high' }), signal()))
    expect(endpoint(fetcher)).toMatch(/\/chat\/completions$/)
    expect(sent(fetcher)).toMatchObject({ reasoning_effort: 'high', max_tokens: 8192, stream_options: { include_usage: true }, tools: [tool] })
    expect(events.filter(event => event.type === 'textDelta').map(event => event.text).join('')).toBe('Visible  answer')
    expect(events.filter(event => event.type === 'toolCallDelta')).toEqual([{ type: 'toolCallDelta', callId: 'call_1', name: 'Read', argumentsDelta: '{"path":' }, { type: 'toolCallDelta', callId: 'call_1', argumentsDelta: '"a.ts"}' }])
    expect(events).toContainEqual({ type: 'usage', usage: { kind: 'actual', inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningTokens: 20 } })
    expect(events.at(-1)).toMatchObject({ type: 'completed', finishReason: 'tool_calls' })
    expect(JSON.stringify(events.filter(event => event.type !== 'completed'))).not.toContain('private')
  })

  it('accepts the injected SDK Chat transport and propagates its exact signal', async () => {
    const { createChatCompletionsAdapter } = await load()
    const sdk = { create: vi.fn(async function* (_body: Record<string, unknown>, _options: { signal: AbortSignal }) { await Promise.resolve(); yield { choices: [{ delta: { content: 'sdk' }, finish_reason: 'stop' }] } }) }
    const abortSignal = signal()
    const adapter = createChatCompletionsAdapter({ client: sdk, capabilities })
    expect(await collect(adapter.stream(request(), abortSignal))).toContainEqual({ type: 'textDelta', text: 'sdk' })
    expect(sdk.create.mock.calls[0][1].signal).toBe(abortSignal)
  })

  it.each(['responses', 'anthropic'] as const)('maps %s native tools, usage and opaque state across a persisted tool round trip', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents)
    const options: AdapterOptions = { fetch: fetcher, apiKey: 'fixture-key', capabilities, effort: protocol === 'responses' ? { parameter: 'reasoning.effort', values: { high: 'high' } } : { parameter: 'output_config.effort', values: { high: 'high' }, thinking: 'adaptive' } }
    const adapter = protocol === 'responses' ? adapters.createResponsesAdapter(options) : adapters.createAnthropicAdapter(options)
    const initial = request({ effort: 'high' })
    const events = await collect(adapter.stream(initial, signal()))
    expect(events.filter(event => event.type === 'textDelta')).toEqual(protocol === 'responses' ? [{ type: 'textDelta', text: 'Work' }, { type: 'textDelta', text: 'ing' }] : [{ type: 'textDelta', text: 'Working' }])
    expect(events.filter(event => event.type === 'toolCallDelta').map(event => event.argumentsDelta).join('')).toBe('{"path":"a.ts"}')
    expect(events).toContainEqual({ type: 'usage', usage: protocol === 'responses' ? { kind: 'actual', inputTokens: 100, cachedInputTokens: 40, outputTokens: 30, reasoningTokens: 20 } : { kind: 'actual', inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 30 } })
    const completion = events.at(-1)
    expect(completion).toMatchObject({ type: 'completed', finishReason: 'tool_calls' })
    if (completion?.type !== 'completed') throw new Error('Expected completion')
    const persisted: unknown = JSON.parse(JSON.stringify(completion.providerState))
    const second = protocol === 'responses' ? adapters.createResponsesAdapter(options) : adapters.createAnthropicAdapter(options)
    await collect(second.stream({ ...initial, messages: following(initial.messages), providerState: persisted }, signal()))
    const body = sent(fetcher, 1)
    if (protocol === 'responses') {
      expect(body).toMatchObject({ store: false, reasoning: { effort: 'high' } })
      expect(body.input).toContainEqual(responseOutput[0])
      expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'file content' })
    } else {
      expect(endpoint(fetcher)).toMatch(/\/messages$/)
      expect(body).toMatchObject({ system: [{ type: 'text', text: 'Follow workspace rules' }], output_config: { effort: 'high' }, thinking: { type: 'adaptive' } })
      expect(JSON.stringify(body.messages)).toContain('native-signature')
      expect(JSON.stringify(body.messages)).toContain('tool_result')
      expect(body.tools).toEqual([{ name: 'Read', description: 'Read a file', input_schema: tool.function.parameters }])
    }
    expect(JSON.stringify(events.filter(event => event.type !== 'completed'))).not.toContain('private')
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('rejects unsupported %s capabilities before opening transport', async protocol => {
    const adapters = await load()
    const fetcher = transport([])
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    for (const changes of [{ tools: false }, { vision: false }, { structuredOutput: false }]) {
      const adapter = make({ fetch: fetcher, capabilities: { ...capabilities, ...changes } })
      const target = changes.vision === false ? request({ tools: [], messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } }] }] }) : changes.structuredOutput === false ? request({ tools: [], responseSchema: { type: 'object', properties: {} } }) : request()
      expect((await collect(adapter.stream(target, signal())))[0]).toMatchObject({ type: 'failed', code: 'unsupported_capability', retryable: false })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['responses', 'anthropic'] as const)('preserves %s image content and structured-output schemas on the native wire', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents, 1)
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    await collect(make({ fetch: fetcher, capabilities }).stream(request({ messages: [{ role: 'user', content: [{ type: 'text', text: '图像 🐈' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }], responseSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }), signal()))
    const body = sent(fetcher)
    expect(JSON.stringify(body)).toContain('图像 🐈')
    if (protocol === 'responses') expect(body).toMatchObject({ input: [{ role: 'user', content: [{ type: 'input_text', text: '图像 🐈' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'auto' }] }], text: { format: { type: 'json_schema', name: 'response', strict: true } } })
    else expect(body).toMatchObject({ messages: [{ role: 'user', content: [{ type: 'text', text: '图像 🐈' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] }], output_config: { format: { type: 'json_schema' } } })
  })

  it.each(['responses', 'anthropic'] as const)('rejects foreign, stale and malformed %s state without transport', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents)
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const adapter = make({ fetch: fetcher, capabilities })
    const initial = request()
    const completed = (await collect(adapter.stream(initial, signal()))).at(-1)
    if (completed?.type !== 'completed') throw new Error('Expected completion')
    const state = completed.providerState as Record<string, unknown>
    for (const changes of [{ model: 'other-model' }, { providerState: { ...state, protocol: protocol === 'responses' ? 'anthropic' : 'responses' } }, { providerState: { ...state, turns: [] } }, { messages: following([{ role: 'user', content: 'changed history' }]) }]) {
      const before = fetcher.mock.calls.length
      expect((await collect(adapter.stream({ ...initial, messages: following(initial.messages), providerState: state, ...changes }, signal())))[0]).toMatchObject({ type: 'failed', code: 'invalid_provider_state', retryable: false })
      expect(fetcher.mock.calls.length).toBe(before)
    }
  })

  it('rejects an unsupported effort mapping and output budget before transport', async () => {
    const { createResponsesAdapter } = await load()
    const fetcher = transport([])
    const adapter = createResponsesAdapter({ fetch: fetcher, capabilities, effort: { parameter: 'reasoning.effort', values: { medium: 'medium' } } })
    expect((await collect(adapter.stream(request({ effort: 'high' }), signal())))[0]).toMatchObject({ type: 'failed', code: 'unsupported_effort' })
    expect((await collect(adapter.stream(request({ maxOutputTokens: 32001 }), signal())))[0]).toMatchObject({ type: 'failed', code: 'invalid_request' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['responses', 'anthropic'] as const)('maps %s HTTP and SSE failures without retry or completion', async protocol => {
    const adapters = await load()
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const http = vi.fn<typeof fetch>(() => Promise.resolve(new Response('fixture-key should not leak', { status: 429 })))
    expect(await collect(make({ fetch: http, apiKey: 'fixture-key', capabilities }).stream(request(), signal()))).toEqual([{ type: 'failed', code: 'http_429', message: 'Model request failed (HTTP 429)', retryable: true }])
    expect(http).toHaveBeenCalledTimes(1)
    const fetcher = transport(protocol === 'responses' ? [{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'error', code: 'server_error', message: 'failure' }] : [{ type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 1 } } }, { type: 'error', error: { type: 'overloaded_error', message: 'failure' } }])
    const events = await collect(make({ fetch: fetcher, capabilities }).stream(request(), signal()))
    expect(events.at(-1)).toMatchObject({ type: 'failed', retryable: true })
    expect(events.some(event => event.type === 'completed')).toBe(false)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('cancels %s before fetch and during a blocked reader', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const controller = new AbortController()
    const fetcher = transport([])
    controller.abort()
    expect(await collect(make({ fetch: fetcher, capabilities }).stream(request(), controller.signal))).toMatchObject([{ type: 'failed', code: 'cancelled', retryable: false }])
    expect(fetcher).not.toHaveBeenCalled()
    const cancelled = vi.fn()
    const blocked = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream({ cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } })))
    const running = new AbortController()
    const result = collect(make({ fetch: blocked, capabilities }).stream(request(), running.signal))
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledOnce())
    running.abort()
    expect((await result).at(-1)).toMatchObject({ type: 'failed', code: 'cancelled' })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it.each(['responses', 'anthropic'] as const)('fails %s truncated streams, malformed JSON and unsafe tool arguments', async protocol => {
    const adapters = await load()
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const truncated = transport(protocol === 'responses' ? [{ type: 'response.output_text.delta', delta: 'partial' }] : anthropicEvents.slice(0, -1))
    expect((await collect(make({ fetch: truncated, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'incomplete_stream' })
    const malformed = vi.fn<typeof fetch>(() => Promise.resolve(new Response('data: {broken}\n\n', { headers: { 'content-type': 'text/event-stream' } })))
    expect((await collect(make({ fetch: malformed, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream' })
    const unsafe = transport(protocol === 'responses' ? [{ type: 'response.completed', response: { output: [{ ...responseOutput[2], arguments: '{' }] } }] : anthropicEvents.map(event => event.type === 'content_block_delta' && event.index === 2 ? { ...event, delta: { type: 'input_json_delta', partial_json: '{' } } : event))
    expect((await collect(make({ fetch: unsafe, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream' })
  })

  it.each(['responses', 'anthropic'] as const)('continues %s through updated marked runtime system instructions while binding historical content', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents)
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const adapter = make({ fetch: fetcher, capabilities })
    const initial = request({ messages: [{ role: 'system', source: 'runtime', content: 'Runtime effort medium' }, { role: 'user', content: 'Read the file' }] })
    const completion = (await collect(adapter.stream(initial, signal()))).at(-1)
    if (completion?.type !== 'completed') throw new Error('Expected completion')
    const nextMessages = following(initial.messages)
    nextMessages[0] = { role: 'system', source: 'runtime', content: 'Runtime effort high; refreshed memory' }
    expect((await collect(adapter.stream({ ...initial, messages: nextMessages, providerState: completion.providerState }, signal()))).at(-1)).toMatchObject({ type: 'completed' })
    expect(JSON.stringify(sent(fetcher, 1))).toContain('Runtime effort high; refreshed memory')
    const before = fetcher.mock.calls.length
    nextMessages[1] = { role: 'user', content: 'Changed historical request' }
    expect((await collect(adapter.stream({ ...initial, messages: nextMessages, providerState: completion.providerState }, signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_provider_state' })
    expect(fetcher.mock.calls.length).toBe(before)
  })

  it('strips stored runtime provider state from Chat wire messages while preserving native reasoning', async () => {
    const { createChatCompletionsAdapter } = await load()
    const fetcher = transport([{ choices: [{ delta: { content: 'Working', reasoning_content: 'opaque', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] }])
    const adapter = createChatCompletionsAdapter({ fetch: fetcher, capabilities })
    const initial = request()
    const completion = (await collect(adapter.stream(initial, signal()))).at(-1)
    if (completion?.type !== 'completed') throw new Error('Expected completion')
    const history = following(initial.messages)
    history[2] = { ...history[2], source: 'runtime', providerState: completion.providerState }
    await collect(adapter.stream({ ...initial, messages: history, providerState: completion.providerState }, signal()))
    const messages = sent(fetcher, 1).messages as Record<string, unknown>[]
    expect(messages[2]).toMatchObject({ role: 'assistant', reasoning_content: 'opaque' })
    expect(messages.every(message => !Object.hasOwn(message, 'providerState') && !Object.hasOwn(message, 'source'))).toBe(true)
    const noStateFetcher = transport([{ choices: [{ delta: { content: 'plain' }, finish_reason: 'stop' }] }])
    await collect(createChatCompletionsAdapter({ fetch: noStateFetcher, capabilities }).stream({ ...initial, messages: history }, signal()))
    expect(JSON.stringify(sent(noStateFetcher).messages)).not.toContain('providerState')
  })

  it.each(['4', new Date(Date.now() + 60000).toUTCString()])('preserves validated HTTP Retry-After %s without adapter retries', async retryAfter => {
    const { createResponsesAdapter } = await load()
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response('', { status: 429, headers: { 'retry-after': retryAfter } })))
    const event = (await collect(createResponsesAdapter({ fetch: fetcher, capabilities }).stream(request(), signal())))[0]
    expect(event).toMatchObject({ type: 'failed', code: 'http_429', retryable: true })
    if (event.type !== 'failed') throw new Error('Expected failure')
    expect(event.retryAfterMs).toBeGreaterThan(0)
    expect(event.retryAfterMs).toBeLessThanOrEqual(60000)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it.each(['responses', 'anthropic'] as const)('keeps compatibility thinking tags private in %s output', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? [
      { type: 'response.output_text.delta', delta: 'safe<thi' }, { type: 'response.output_text.delta', delta: 'nk>private</think> answer' },
      { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'safe<think>private</think> answer' }] }] } },
    ] : [
      { type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'safe<thi' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'nk>private</think> answer' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' },
    ])
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const events = await collect(make({ fetch: fetcher, capabilities }).stream(request(), signal()))
    expect(events.at(-1)).toMatchObject({ type: 'completed' })
    expect(events.filter(event => event.type === 'textDelta').map(event => event.text).join('')).toBe('safe answer')
    expect(JSON.stringify(events.filter(event => event.type !== 'completed'))).not.toContain('private')
  })

  it('rejects a Responses completion that drops an already streamed tool call', async () => {
    const { createResponsesAdapter } = await load()
    const fetcher = transport([{ type: 'response.output_item.added', output_index: 0, item: responseOutput[2] }, { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '' }] }] } }])
    expect((await collect(createResponsesAdapter({ fetch: fetcher, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream' })
  })

  it.each(['responses', 'anthropic'] as const)('preserves multimodal tool results in %s rather than encoding images as text', async protocol => {
    const adapters = await load()
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents)
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const messages = following(request().messages)
    messages.at(-1)!.content = [{ type: 'text', text: 'Screenshot' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }]
    expect((await collect(make({ fetch: fetcher, capabilities }).stream(request({ messages }), signal()))).at(-1)).toMatchObject({ type: 'completed' })
    const body = sent(fetcher)
    if (protocol === 'responses') expect(body.input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: [{ type: 'input_text', text: 'Screenshot' }, { type: 'input_image', image_url: 'data:image/png;base64,YQ==', detail: 'auto' }] })
    else expect(body.messages).toContainEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'Screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YQ==' } }] }] })
  })

  it('maps reported native Anthropic thinking usage without estimating hidden tokens', async () => {
    const { createAnthropicAdapter } = await load()
    const fetcher = transport(anthropicEvents.map(event => event.type === 'message_delta' ? { ...event, usage: { output_tokens: 30, output_tokens_details: { thinking_tokens: 20 } } } : event))
    const events = await collect(createAnthropicAdapter({ fetch: fetcher, capabilities }).stream(request(), signal()))
    expect(events).toContainEqual({ type: 'usage', usage: { kind: 'actual', inputTokens: 100, cachedInputTokens: 30, cacheWriteTokens: 10, outputTokens: 30, reasoningTokens: 20 } })
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('rejects corrupted UTF-8 from %s as a nonretryable protocol error', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const cancelled = vi.fn()
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([0xc3, 0x28])) }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } })))
    expect((await collect(make({ fetch: fetcher, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream', retryable: false })
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('rejects parallel Chat calls that share an identity before exposing a completed turn', async () => {
    const { createChatCompletionsAdapter } = await load()
    const fetcher = transport([{ choices: [{ delta: { tool_calls: [0, 1].map(index => ({ index, id: 'same_call', function: { name: 'Read', arguments: '{}' } })) }, finish_reason: 'tool_calls' }] }])
    const events = await collect(createChatCompletionsAdapter({ fetch: fetcher, capabilities }).stream(request(), signal()))
    expect(events.at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream' })
    expect(events.some(event => event.type === 'completed')).toBe(false)
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('keeps %s admission capabilities stable when exposed snapshots are changed', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const supplied = { ...capabilities, tools: false }
    const fetcher = transport([])
    const adapter = make({ fetch: fetcher, capabilities: supplied })
    supplied.tools = true
    Reflect.set(adapter.capabilities, 'tools', true)
    expect((await collect(adapter.stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_capability' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['responses', 'anthropic'] as const)('binds unmarked system instructions and retains every native %s tool turn across restart', async protocol => {
    const adapters = await load()
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const nativeEvents = protocol === 'responses' ? responseEvents : anthropicEvents
    const fetcher = transport(nativeEvents)
    const options = { fetch: fetcher, capabilities }
    const initial = request()
    const first = (await collect(make(options).stream(initial, signal()))).at(-1)
    if (first?.type !== 'completed') throw new Error('Expected first native completion')
    const secondMessages = following(initial.messages)
    const changed = structuredClone(secondMessages)
    changed[0].content = 'Changed historical system instructions'
    expect((await collect(make(options).stream({ ...initial, messages: changed, providerState: first.providerState }, signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_provider_state' })
    expect(fetcher).toHaveBeenCalledOnce()
    const second = (await collect(make(options).stream({ ...initial, messages: secondMessages, providerState: JSON.parse(JSON.stringify(first.providerState)) as unknown }, signal()))).at(-1)
    if (second?.type !== 'completed') throw new Error('Expected second native completion')
    const thirdMessages = following(secondMessages)
    expect((await collect(make(options).stream({ ...initial, messages: thirdMessages, providerState: JSON.parse(JSON.stringify(second.providerState)) as unknown }, signal()))).at(-1)).toMatchObject({ type: 'completed' })
    const finalWire = JSON.stringify(sent(fetcher, 2))
    expect(finalWire.split(protocol === 'responses' ? 'opaque-reasoning' : 'native-signature').length - 1).toBe(2)
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('rejects %s native continuation at a different provider endpoint', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const fetcher = transport(protocol === 'chat-completions' ? [{ choices: [{ delta: { content: 'Working', tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }] }, finish_reason: 'tool_calls' }] }] : protocol === 'responses' ? responseEvents : anthropicEvents)
    const initial = request()
    const completed = (await collect(make({ fetch: fetcher, capabilities, baseURL: 'https://first.invalid/v1' }).stream(initial, signal()))).at(-1)
    if (completed?.type !== 'completed') throw new Error('Expected native completion')
    const second = make({ fetch: fetcher, capabilities, baseURL: 'https://second.invalid/v1' })
    expect((await collect(second.stream({ ...initial, messages: following(initial.messages), providerState: completed.providerState }, signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_provider_state' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('parses SSE metadata, multiline data and bare CR boundaries and bounds oversized frames', async () => {
    const { createResponsesAdapter } = await load()
    const source = ': heartbeat\revent: response.completed\rid: fixture\rdata: {"type":"response.completed",\rdata: "response":{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"OK"}]}]}}\r\r'
    const bytes = new TextEncoder().encode(source)
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close() } }), { headers: { 'content-type': 'text/event-stream' } })))
    expect((await collect(createResponsesAdapter({ fetch: fetcher, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'completed' })
    const oversized = vi.fn<typeof fetch>(() => Promise.resolve(new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'x'.repeat(1024 * 1024) })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })))
    expect((await collect(createResponsesAdapter({ fetch: oversized, capabilities }).stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_stream', retryable: false })
  })

  it.each(['chat-completions', 'responses'] as const)('retains actual %s usage when the provider cannot produce a valid completed turn', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : adapters.createResponsesAdapter
    const fetcher = transport(protocol === 'chat-completions' ? [
      { choices: [], usage: { prompt_tokens: 100, completion_tokens: 30 } }, { choices: [], error: { message: 'Provider failed after usage' } },
    ] : [{ type: 'response.completed', response: { output: [{ ...responseOutput[2], arguments: '{' }], usage: { input_tokens: 100, output_tokens: 30 } } }])
    const events = await collect(make({ fetch: fetcher, capabilities }).stream(request(), signal()))
    expect(events).toContainEqual({ type: 'usage', usage: { kind: 'actual', inputTokens: 100, outputTokens: 30 } })
    expect(events.at(-1)).toMatchObject({ type: 'failed' })
    expect(events.some(event => event.type === 'completed')).toBe(false)
  })

  it.each(['responses', 'anthropic'] as const)('does not treat historical %s system text as a runtime continuity marker', async protocol => {
    const adapters = await load()
    const make = protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const fetcher = transport(protocol === 'responses' ? responseEvents : anthropicEvents)
    const adapter = make({ fetch: fetcher, capabilities })
    const initial = request({ messages: [{ role: 'system', content: '__runtime_instructions__' }, { role: 'user', content: 'Read the file' }] })
    const completed = (await collect(adapter.stream(initial, signal()))).at(-1)
    if (completed?.type !== 'completed') throw new Error('Expected native completion')
    const messages = following(initial.messages)
    messages[0] = { role: 'system', source: 'runtime', content: 'Changed instructions' }
    expect((await collect(adapter.stream({ ...initial, messages, providerState: completed.providerState }, signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'invalid_provider_state' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('validates Anthropic explicit thinking budgets and rejects incompatible temperature before transport', async () => {
    const { createAnthropicAdapter } = await load()
    const fetcher = transport(anthropicEvents)
    const adapter = createAnthropicAdapter({ fetch: fetcher, capabilities, effort: { parameter: 'thinking.budget_tokens', values: { low: 512, medium: 1024, high: 8192 } } })
    for (const changes of [{ effort: 'low' as const }, { effort: 'high' as const }, { temperature: 0 }]) expect((await collect(adapter.stream(request(changes), signal()))).at(-1)).toMatchObject({ type: 'failed' })
    expect(fetcher).not.toHaveBeenCalled()
    expect((await collect(adapter.stream(request({ temperature: 1 }), signal()))).at(-1)).toMatchObject({ type: 'completed' })
    expect(sent(fetcher)).toMatchObject({ thinking: { type: 'enabled', budget_tokens: 1024 }, temperature: 1 })
    const nonreasoning = createAnthropicAdapter({ fetch: fetcher, capabilities: { ...capabilities, reasoning: false }, effort: { parameter: 'thinking.budget_tokens', values: { medium: 1024 } } })
    expect((await collect(nonreasoning.stream(request(), signal()))).at(-1)).toMatchObject({ type: 'failed', code: 'unsupported_capability' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each(['chat-completions', 'responses', 'anthropic'] as const)('closes the %s physical reader when its consumer stops after one event', async protocol => {
    const adapters = await load()
    const make = protocol === 'chat-completions' ? adapters.createChatCompletionsAdapter : protocol === 'responses' ? adapters.createResponsesAdapter : adapters.createAnthropicAdapter
    const event = protocol === 'chat-completions' ? { choices: [{ delta: { content: 'partial' } }] } : protocol === 'responses' ? { type: 'response.output_text.delta', delta: 'partial' } : [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } }]
    const cancelled = vi.fn()
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(sse(Array.isArray(event) ? event : [event], false))) }, cancel: cancelled }), { headers: { 'content-type': 'text/event-stream' } })))
    const iterator = make({ fetch: fetcher, capabilities }).stream(request(), signal())[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'textDelta', text: 'partial' })
    await iterator.return?.()
    expect(cancelled).toHaveBeenCalledOnce()
  })

  it('uses a real loopback HTTP endpoint with native Anthropic headers and a physical SSE response', async () => {
    const { createAnthropicAdapter } = await load()
    const observed: Array<{ path?: string; key?: string; version?: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => { body += chunk })
      req.on('end', () => {
        observed.push({ path: req.url, key: req.headers['x-api-key'] as string, version: req.headers['anthropic-version'] as string, body })
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(sse(anthropicEvents, false))
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('No loopback address')
      const events = await collect(createAnthropicAdapter({ baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'offline-fixture', capabilities }).stream(request(), signal()))
      expect(events.at(-1)).toMatchObject({ type: 'completed' })
      expect(observed).toMatchObject([{ path: '/v1/messages', key: 'offline-fixture', version: '2023-06-01' }])
      expect(JSON.parse(observed[0].body) as unknown).toMatchObject({ model: 'fixture-model', stream: true })
    } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
  })
})
