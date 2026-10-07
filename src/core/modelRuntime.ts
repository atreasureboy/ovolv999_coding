import type OpenAI from 'openai'
import { randomUUID } from 'node:crypto'
import type { EngineConfig, OpenAIMessage } from './types.js'
import { resolveContextWindow } from './compact/budget.js'
import { getModelInfo } from './providers.js'
import { createChatCompletionsAdapter, createResponsesAdapter, createAnthropicAdapter } from './model/index.js'
import { AdapterError, effortParameters, validateRequest } from './model/common.js'
import { historyDigest } from './model/state.js'
import type { AdapterOptions, ModelAdapter, ModelCapabilities, ModelEvent, ModelProtocol, ModelRequest, NormalizedUsage, ProviderContinuationState } from './model/types.js'

export interface GatewayChunk extends OpenAI.Chat.ChatCompletionChunk {
  normalizedUsage?: NormalizedUsage
  providerState?: ProviderContinuationState
}

export function resolveModelRuntime(config: EngineConfig, model = config.model): { protocol: ModelProtocol; options: AdapterOptions } {
  const settings = config.modelSettings && Object.hasOwn(config.modelSettings, model) ? config.modelSettings[model] : undefined
  const nativeEndpoint = (() => { try { return new URL(config.baseURL ?? '').hostname === 'api.anthropic.com' } catch { return false } })()
  const protocol = settings?.protocol ?? config.modelProtocol ?? (nativeEndpoint ? 'anthropic' : 'chat-completions')
  const info = getModelInfo(model)
  const capabilities: ModelCapabilities = {
    tools: info ? info.supportsTools ?? false : true,
    vision: info?.supportsVision ?? false,
    reasoning: info?.supportsReasoning ?? false,
    structuredOutput: false,
    contextWindow: resolveContextWindow(model, config.maxContextTokens),
    maxOutputTokens: info?.maxOutputTokens ?? Math.max(1, Math.floor(resolveContextWindow(model, config.maxContextTokens) / 2)),
    ...settings?.capabilities,
  }
  return { protocol, options: { capabilities, baseURL: config.baseURL, apiKey: config.apiKey, effort: settings?.effort } }
}

export function gatewayModelRequest(config: EngineConfig, params: OpenAI.Chat.ChatCompletionCreateParams, maxOutputTokens: number): ModelRequest {
  const messages = params.messages as OpenAIMessage[]
  const states = messages.filter(message => message.providerState !== undefined)
  const format = params.response_format
  const tools: ModelRequest['tools'] = (params.tools ?? []).map(tool => {
    const parameters = tool.function.parameters ?? {}
    const properties = parameters.properties ?? {}
    if (parameters.type !== undefined && parameters.type !== 'object' || !properties || typeof properties !== 'object' || Array.isArray(properties)) throw new AdapterError('invalid_request', 'Tool parameters require an object schema')
    return { type: 'function', function: { name: tool.function.name, description: tool.function.description ?? '', parameters: { ...structuredClone(parameters), type: 'object', properties: structuredClone(properties) as Record<string, unknown> } } }
  })
  return {
    model: params.model,
    messages: structuredClone(messages),
    tools,
    effort: config.effort ?? 'medium',
    maxOutputTokens,
    ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
    ...(format?.type === 'json_schema' ? { responseSchema: format.json_schema.schema } : {}),
    ...(states.length ? { providerState: structuredClone(states.at(-1)!.providerState) } : {}),
  }
}

export function validateGatewayModelRequest(request: ModelRequest, protocol: ModelProtocol, options: AdapterOptions, adapter?: ModelAdapter): Record<string, unknown> {
  validateRequest(request, options)
  const effort = effortParameters(protocol, options.effort, request, options)
  if (request.providerState !== undefined && adapter) {
    const state = adapter.validateState(request.providerState, request.model)
    for (const turn of state.turns) if (turn.messageIndex >= request.messages.length || historyDigest(request.messages.slice(0, turn.messageIndex)) !== turn.prefixDigest || historyDigest([request.messages[turn.messageIndex]]) !== turn.messageDigest) throw new AdapterError('invalid_provider_state', 'Native continuation does not match the conversation history')
  }
  return effort
}

export function nativeModelAdapter(protocol: ModelProtocol, options: AdapterOptions): ModelAdapter {
  if (protocol === 'responses') return createResponsesAdapter(options)
  if (protocol === 'anthropic') return createAnthropicAdapter(options)
  return createChatCompletionsAdapter(options)
}

function modelFailure(event: Extract<ModelEvent, { type: 'failed' }>): Error {
  return Object.assign(new Error(event.message), { code: event.code, retryable: event.retryable, ...(event.retryAfterMs === undefined ? {} : { headers: { 'retry-after': String(event.retryAfterMs / 1000) } }) })
}

export async function sendNativeModelRequest(adapter: ModelAdapter, request: ModelRequest, streaming: boolean, signal: AbortSignal): Promise<AsyncIterable<GatewayChunk> | OpenAI.Chat.ChatCompletion> {
  const iterator = adapter.stream(request, signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new AdapterError('incomplete_stream', 'Model stream ended before producing a response')
  if (first.value.type === 'failed') { await iterator.return?.(); throw modelFailure(first.value) }
  const requestId = randomUUID()
  const calls = new Map<string, number>()
  const chunk = (choices: OpenAI.Chat.ChatCompletionChunk['choices'], extra: Partial<GatewayChunk> = {}): GatewayChunk => ({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model, choices, ...extra })
  const response: AsyncIterable<GatewayChunk> = {
    async *[Symbol.asyncIterator]() {
      let next: IteratorResult<ModelEvent> = first
      let completed = false
      let reportedUsage: NormalizedUsage | undefined
      try {
        while (!next.done) {
          signal.throwIfAborted()
          const event = next.value
          if (event.type === 'failed') throw modelFailure(event)
          if (event.type === 'progress' || event.type === 'reasoningDelta') yield chunk([])
          else if (event.type === 'textDelta') yield chunk([{ index: 0, delta: { content: event.text }, finish_reason: null }])
          else if (event.type === 'toolCallDelta') {
            const index = calls.get(event.callId) ?? calls.size
            calls.set(event.callId, index)
            yield chunk([{ index: 0, delta: { tool_calls: [{ index, id: event.callId, type: 'function', function: { ...(event.name === undefined ? {} : { name: event.name }), arguments: event.argumentsDelta } }] }, finish_reason: null }])
          } else if (event.type === 'usage') {
            const usage = event.usage
            reportedUsage = usage
            yield chunk([], { normalizedUsage: usage, ...(usage.kind === 'actual' && usage.inputTokens !== undefined && usage.outputTokens !== undefined ? { usage: { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens, total_tokens: usage.inputTokens + usage.outputTokens, prompt_tokens_details: { cached_tokens: usage.cachedInputTokens ?? 0 }, completion_tokens_details: { reasoning_tokens: usage.reasoningTokens ?? 0 } } } : {}) })
          } else if (event.type === 'completed') {
            completed = true
            yield chunk([{ index: 0, delta: {}, finish_reason: event.finishReason ?? (calls.size ? 'tool_calls' : 'stop') }], { providerState: event.providerState as ProviderContinuationState | undefined })
          }
          next = await iterator.next()
        }
        if (!completed) throw new AdapterError('incomplete_stream', 'Model stream ended without completion')
      } catch (error) {
        throw Object.assign(new Error(error instanceof Error ? error.message : String(error), { cause: error }), { retryable: false, ...(reportedUsage ? { normalizedUsage: reportedUsage } : {}) })
      } finally { await iterator.return?.() }
    },
  }
  if (streaming) return response
  let content = ''
  let finishReason: OpenAI.Chat.ChatCompletion.Choice['finish_reason'] = 'stop'
  let usage: OpenAI.Chat.ChatCompletion['usage']
  let normalizedUsage: NormalizedUsage | undefined
  let providerState: ProviderContinuationState | undefined
  const toolCalls = new Map<number, OpenAI.Chat.ChatCompletionMessageToolCall>()
  for await (const value of response) {
    usage = value.usage ?? usage
    normalizedUsage = value.normalizedUsage ?? normalizedUsage
    providerState = value.providerState ?? providerState
    const choice = value.choices[0]
    if (!choice) continue
    content += choice.delta.content ?? ''
    if (choice.finish_reason) finishReason = choice.finish_reason
    for (const call of choice.delta.tool_calls ?? []) {
      const accumulated = toolCalls.get(call.index) ?? { id: call.id ?? '', type: 'function' as const, function: { name: '', arguments: '' } }
      accumulated.function.name += call.function?.name ?? ''
      accumulated.function.arguments += call.function?.arguments ?? ''
      toolCalls.set(call.index, accumulated)
    }
  }
  return { id: requestId, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: request.model, choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message: { role: 'assistant', content: content || null, refusal: null, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) } }], usage, normalizedUsage, providerState } as OpenAI.Chat.ChatCompletion
}
