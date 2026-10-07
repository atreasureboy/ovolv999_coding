import { isEffortLevel } from '../effort.js'
import type { ContentPart } from '../types.js'
import type { AdapterEffort, AdapterOptions, ModelEvent, ModelProtocol, ModelRequest, NormalizedUsage } from './types.js'

export class AdapterError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false, readonly retryAfterMs?: number) { super(message) }
}
export function providerEndpoint(protocol: ModelProtocol, options: AdapterOptions): string {
  return (options.baseURL ?? (protocol === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1')).replace(/\/+$/, '')
}
export function record(value: unknown, code = 'invalid_stream'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterError(code, 'Expected a protocol object')
  return value as Record<string, unknown>
}
export function text(value: unknown, code = 'invalid_stream'): string {
  if (typeof value !== 'string') throw new AdapterError(code, 'Expected protocol text')
  return value
}
export function array(value: unknown, code = 'invalid_stream'): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError(code, 'Expected a protocol array')
  return value
}
export function index(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new AdapterError('invalid_stream', 'Invalid protocol index')
  return Number(value)
}
export function parseArguments(value: string): Record<string, unknown> {
  try { return record(JSON.parse(value) as unknown) } catch { throw new AdapterError('invalid_stream', 'Tool arguments must be a complete JSON object') }
}
export function imageUrl(part: ContentPart): string {
  const url = part.image_url?.url
  if (typeof url !== 'string' || !(/^(https?:\/\/[^\s]+|data:image\/(png|jpeg|gif|webp);base64,[a-zA-Z0-9+/]+={0,2})$/.test(url))) throw new AdapterError('invalid_request', 'Image input requires an HTTP URL or supported base64 image')
  return url
}
export function validateRequest(request: ModelRequest, options: AdapterOptions): void {
  const capabilities = options.capabilities
  if (!Number.isSafeInteger(capabilities.contextWindow) || capabilities.contextWindow < 1 || !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 1) throw new AdapterError('invalid_request', 'Invalid model token capabilities')
  if (!request.model?.trim() || !isEffortLevel(request.effort)) throw new AdapterError('invalid_request', 'Invalid model request')
  array(request.messages, 'invalid_request')
  array(request.tools, 'invalid_request')
  if (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > capabilities.maxOutputTokens || request.maxOutputTokens >= capabilities.contextWindow) throw new AdapterError('invalid_request', 'Requested output budget exceeds model capability')
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) throw new AdapterError('invalid_request', 'Invalid model temperature')
  if (!capabilities.tools && (request.tools.length || request.messages.some(message => message.role === 'tool' || message.tool_calls?.length))) throw new AdapterError('unsupported_capability', 'This model does not support tools')
  if (request.responseSchema && !capabilities.structuredOutput) throw new AdapterError('unsupported_capability', 'This model does not support structured output')
  for (const message of request.messages) {
    if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) throw new AdapterError('invalid_request', 'Unsupported message role')
    if (typeof message.content !== 'string' && message.content !== null && !Array.isArray(message.content)) throw new AdapterError('invalid_request', 'Invalid message content')
    if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type === 'image_url') {
        if (!capabilities.vision) throw new AdapterError('unsupported_capability', 'This model does not support image input')
        imageUrl(part)
      } else if (part.type !== 'text' || typeof part.text !== 'string') throw new AdapterError('invalid_request', 'Invalid message content part')
    }
    if (message.role === 'tool' && !message.tool_call_id) throw new AdapterError('invalid_request', 'Tool result requires its call ID')
    for (const call of message.tool_calls ?? []) if (!call.id || call.type !== 'function' || !call.function?.name || typeof call.function.arguments !== 'string') throw new AdapterError('invalid_request', 'Invalid tool call history')
  }
  if (request.responseSchema) record(request.responseSchema, 'invalid_request')
  for (const tool of request.tools) if (tool.type !== 'function' || !tool.function?.name || !tool.function.parameters) throw new AdapterError('invalid_request', 'Invalid tool definition')
}
export function effortParameters(protocol: ModelProtocol, effort: AdapterEffort | undefined, request: ModelRequest, options: AdapterOptions): Record<string, unknown> {
  if (!effort) return {}
  if (!options.capabilities.reasoning) throw new AdapterError('unsupported_capability', 'This model does not support native reasoning effort')
  const value = effort.values[request.effort]
  if (value === undefined) throw new AdapterError('unsupported_effort', `Effort ${request.effort} is not supported by this model mapping`)
  if (protocol === 'chat-completions' && effort.parameter === 'reasoning_effort' && typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) return { reasoning_effort: value }
  if (protocol === 'responses' && effort.parameter === 'reasoning.effort' && typeof value === 'string' && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) return { reasoning: { effort: value } }
  if (protocol === 'anthropic' && effort.parameter === 'output_config.effort' && typeof value === 'string' && ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) return { output_config: { effort: value }, ...(effort.thinking === 'adaptive' ? { thinking: { type: 'adaptive' } } : {}) }
  if (protocol === 'anthropic' && effort.parameter === 'thinking.budget_tokens' && Number.isSafeInteger(value) && Number(value) >= 1024 && Number(value) < request.maxOutputTokens) return { thinking: { type: 'enabled', budget_tokens: value } }
  throw new AdapterError('unsupported_effort', 'Effort mapping is not supported by this protocol or output budget')
}
export function failure(error: unknown, signal: AbortSignal, key?: string): Extract<ModelEvent, { type: 'failed' }> {
  if (signal.aborted) return { type: 'failed', code: 'cancelled', message: 'Model request cancelled', retryable: false }
  if (error instanceof AdapterError) return { type: 'failed', code: error.code, message: key ? error.message.split(key).join('[REDACTED]') : error.message, retryable: error.retryable, ...(Number.isFinite(error.retryAfterMs) && Number(error.retryAfterMs) >= 0 ? { retryAfterMs: error.retryAfterMs } : {}) }
  const value = error && typeof error === 'object' ? error as { status?: unknown; message?: unknown; name?: unknown } : {}
  const status = Number(value.status)
  let message = typeof value.message === 'string' ? value.message.slice(0, 1024) : 'Model transport failed'
  if (key) message = message.split(key).join('[REDACTED]')
  return { type: 'failed', code: Number.isSafeInteger(status) && status > 0 ? `http_${status}` : 'transport_error', message, retryable: status === 408 || status === 429 || status >= 500 || value.name === 'APIConnectionError' || value.name === 'APIConnectionTimeoutError' || error instanceof TypeError }
}
export async function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { cleanup(); reject(new AdapterError('cancelled', 'Model request cancelled')) }
    const cleanup = (): void => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error instanceof Error ? error : new Error('Model transport failed')) })
    if (signal.aborted) onAbort()
  })
}
export function normalizeUsage(value: unknown, protocol: ModelProtocol): NormalizedUsage {
  if (!value) return { kind: 'unknown' }
  const usage = record(value)
  const token = (key: string, source = usage): number | undefined => {
    if (source[key] === undefined || source[key] === null) return undefined
    if (!Number.isSafeInteger(source[key]) || Number(source[key]) < 0) throw new AdapterError('invalid_stream', 'Invalid provider token usage')
    return Number(source[key])
  }
  const input = token(protocol === 'chat-completions' ? 'prompt_tokens' : 'input_tokens')
  const output = token(protocol === 'chat-completions' ? 'completion_tokens' : 'output_tokens')
  if (input === undefined || output === undefined) return { kind: 'unknown' }
  const cached = protocol === 'anthropic' ? token('cache_read_input_tokens') : token('cached_tokens', usage[protocol === 'chat-completions' ? 'prompt_tokens_details' : 'input_tokens_details'] ? record(usage[protocol === 'chat-completions' ? 'prompt_tokens_details' : 'input_tokens_details']) : {})
  const written = protocol === 'anthropic' ? token('cache_creation_input_tokens') : undefined
  const reasoning = token(protocol === 'anthropic' ? 'thinking_tokens' : 'reasoning_tokens', usage[protocol === 'chat-completions' ? 'completion_tokens_details' : 'output_tokens_details'] ? record(usage[protocol === 'chat-completions' ? 'completion_tokens_details' : 'output_tokens_details']) : {})
  const total = input + (protocol === 'anthropic' ? (cached ?? 0) + (written ?? 0) : 0)
  if (!Number.isSafeInteger(total) || (protocol !== 'anthropic' && (cached ?? 0) > input) || (reasoning ?? 0) > output) throw new AdapterError('invalid_stream', 'Inconsistent provider token usage')
  return { kind: 'actual', inputTokens: total, outputTokens: output, ...(cached === undefined ? {} : { cachedInputTokens: cached }), ...(written === undefined ? {} : { cacheWriteTokens: written }), ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }) }
}
