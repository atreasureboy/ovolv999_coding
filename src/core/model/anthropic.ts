import type { ContentPart, OpenAIMessage, ToolCall } from '../types.js'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import { AdapterError, effortParameters, failure, imageUrl, index, normalizeUsage, parseArguments, record, text, validateRequest } from './common.js'
import { completeState, nativeTurn, ownOptions, providerIdentity, requestState, validateState, visibleText } from './state.js'
import { httpEvents } from './transport.js'
import type { AdapterOptions, ModelAdapter, ModelEvent, ModelRequest, ProviderContinuationState } from './types.js'

function project(items: Record<string, unknown>[]): OpenAIMessage {
  let content = ''
  const calls: ToolCall[] = []
  for (const block of items) {
    if (block.type === 'text') content += text(block.text)
    else if (block.type === 'thinking') { text(block.thinking); if (!text(block.signature)) throw new AdapterError('invalid_stream', 'Native thinking signature is missing') }
    else if (block.type === 'redacted_thinking') { if (!text(block.data)) throw new AdapterError('invalid_stream', 'Native redacted thinking data is missing') }
    else if (block.type === 'tool_use') {
      const id = text(block.id)
      const name = text(block.name)
      if (!id || !name || calls.some(call => call.id === id)) throw new AdapterError('invalid_stream', 'Invalid Messages tool identity')
      const input = record(block.input)
      calls.push({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } })
    } else throw new AdapterError('invalid_stream', 'Unsupported Messages content block')
  }
  return { role: 'assistant', content: visibleText(content), ...(calls.length ? { tool_calls: calls } : {}) }
}
function parts(content: string | null | ContentPart[]): Record<string, unknown>[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return (content ?? []).map(part => {
    if (part.type === 'text') return { type: 'text', text: part.text }
    const url = imageUrl(part)
    const encoded = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(url)
    return { type: 'image', source: encoded ? { type: 'base64', media_type: encoded[1], data: encoded[2] } : { type: 'url', url } }
  })
}
function nativeMessages(request: ModelRequest, state: ProviderContinuationState | undefined): { system: Record<string, unknown>[]; messages: Record<string, unknown>[] } {
  const system: Record<string, unknown>[] = []
  const messages: Array<{ role: string; content: Record<string, unknown>[] }> = []
  request.messages.forEach((message, messageIndex) => {
    if (message.role === 'system') {
      if (Array.isArray(message.content) && message.content.some(part => part.type !== 'text')) throw new AdapterError('invalid_request', 'Messages system instructions must be text')
      system.push(...parts(message.content))
      return
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const native = nativeTurn(state, messageIndex)
    let content = native ?? parts(message.content)
    if (message.role === 'tool') content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content }]
    else if (!native) for (const call of message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: parseArguments(call.function.arguments) })
    if (!content.length) throw new AdapterError('invalid_request', 'Messages content must not be empty')
    const previous = messages.at(-1)
    if (previous?.role === role) previous.content.push(...content)
    else messages.push({ role, content })
  })
  if (messages[0]?.role !== 'user') throw new AdapterError('invalid_request', 'Messages history must begin with a user message')
  return { system, messages }
}
export function createAnthropicAdapter(configuration: AdapterOptions): ModelAdapter {
  const options = ownOptions(configuration)
  const protocol = 'anthropic' as const
  const provider = providerIdentity(protocol, options)
  return { protocol, capabilities: options.capabilities, validateState: (state, model) => validateState(state, protocol, model, project, provider), stream: (request, signal) => stream(structuredClone(request), signal) }
  async function* stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    let usage: Record<string, unknown> | undefined
    let reported = false
    try {
      signal.throwIfAborted()
      validateRequest(request, options)
      if (request.temperature !== undefined && request.temperature > 1) throw new AdapterError('invalid_request', 'Messages temperature must be between zero and one')
      const prior = requestState(request, protocol, project, provider)
      const effort = effortParameters(protocol, options.effort, request, options)
      if (effort.thinking && request.temperature !== undefined && request.temperature !== 1) throw new AdapterError('unsupported_capability', 'Explicit temperature is incompatible with enabled native thinking')
      const body = { model: request.model, ...nativeMessages(request, prior), max_tokens: request.maxOutputTokens, stream: true, tools: request.tools.map(tool => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })), ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...effort, ...(request.responseSchema ? { output_config: { ...(effort.output_config ? record(effort.output_config) : {}), format: { type: 'json_schema', schema: request.responseSchema } } } : {}) }
      const blocks = new Map<number, { value: Record<string, unknown>; arguments: string; closed: boolean }>()
      let started = false
      let stopReason: string | undefined
      const filter = new ThinkingTagFilter()
      for await (const value of httpEvents(protocol, body, options, signal)) {
        const event = record(value)
        const type = text(event.type)
        if (type === 'message_start') {
          if (started) throw new AdapterError('invalid_stream', 'Messages stream started twice')
          started = true
          const message = record(event.message)
          usage = message.usage ? record(message.usage) : undefined
        } else if (type === 'content_block_start') {
          if (!started) throw new AdapterError('invalid_stream', 'Content arrived before message start')
          const at = index(event.index)
          if (blocks.has(at)) throw new AdapterError('invalid_stream', 'Content block identity was repeated')
          const block = record(event.content_block)
          if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(String(block.type))) throw new AdapterError('invalid_stream', 'Unsupported Messages content block')
          blocks.set(at, { value: { ...block }, arguments: '', closed: false })
          if (block.type === 'tool_use') {
            const id = text(block.id); const name = text(block.name)
            if (!id || !name) throw new AdapterError('invalid_stream', 'Invalid Messages tool identity')
            record(block.input)
            yield { type: 'toolCallDelta', callId: id, name, argumentsDelta: '' }
          } else if (block.type === 'text') {
            const raw = text(block.text)
            const value = filter.push(raw)
            filter.drainThinking()
            if (value) yield { type: 'textDelta', text: value }
            else if (raw) yield { type: 'progress' }
          }
          else if (block.type === 'thinking' || block.type === 'redacted_thinking') yield { type: 'reasoningDelta', text: '' }
        } else if (type === 'content_block_delta') {
          const block = blocks.get(index(event.index))
          if (!block || block.closed) throw new AdapterError('invalid_stream', 'Delta has no open content block')
          const delta = record(event.delta)
          if (delta.type === 'text_delta' && block.value.type === 'text') {
            const value = text(delta.text)
            block.value.text = text(block.value.text) + value
            const visible = filter.push(value); filter.drainThinking()
            if (visible) yield { type: 'textDelta', text: visible }
            else if (value) yield { type: 'progress' }
          } else if (delta.type === 'thinking_delta' && block.value.type === 'thinking') {
            const value = text(delta.thinking)
            block.value.thinking = text(block.value.thinking) + value
            if (value) yield { type: 'progress' }
          } else if (delta.type === 'signature_delta' && block.value.type === 'thinking') {
            const value = text(delta.signature)
            block.value.signature = text(block.value.signature ?? '') + value
            if (value) yield { type: 'progress' }
          }
          else if (delta.type === 'input_json_delta' && block.value.type === 'tool_use') {
            const value = text(delta.partial_json)
            block.arguments += value
            yield { type: 'toolCallDelta', callId: text(block.value.id), argumentsDelta: value }
          } else throw new AdapterError('invalid_stream', 'Delta does not match its native content block')
        } else if (type === 'content_block_stop') {
          const block = blocks.get(index(event.index))
          if (!block || block.closed) throw new AdapterError('invalid_stream', 'Content block cannot be closed')
          block.closed = true
          if (block.value.type === 'tool_use') {
            if (block.arguments) block.value.input = parseArguments(block.arguments)
            else yield { type: 'toolCallDelta', callId: text(block.value.id), argumentsDelta: JSON.stringify(record(block.value.input)) }
          }
          project([block.value])
        } else if (type === 'message_delta') {
          if (!started) throw new AdapterError('invalid_stream', 'Message delta arrived before start')
          const delta = record(event.delta)
          if (delta.stop_reason !== undefined && delta.stop_reason !== null) stopReason = text(delta.stop_reason)
          if (event.usage) usage = { ...usage, ...record(event.usage) }
        } else if (type === 'error') {
          const error = record(event.error)
          throw new AdapterError(typeof error.type === 'string' ? error.type : 'provider_error', typeof error.message === 'string' ? error.message.slice(0, 1024) : 'Messages provider failed', ['overloaded_error', 'rate_limit_error', 'api_error'].includes(String(error.type)))
        } else if (type === 'message_stop') {
          if (!started || !stopReason || [...blocks.values()].some(block => !block.closed)) throw new AdapterError('invalid_stream', 'Messages response ended with incomplete content')
          if (!['end_turn', 'tool_use', 'max_tokens', 'stop_sequence'].includes(stopReason)) throw new AdapterError(stopReason === 'refusal' ? 'content_filter' : 'incomplete_response', 'Provider did not complete a supported Messages turn')
          const output = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => block.value)
          const assistant = project(output)
          const trailing = filter.finish(); filter.drainThinking()
          if (trailing) yield { type: 'textDelta', text: trailing }
          if (stopReason === 'tool_use' && !assistant.tool_calls?.length) throw new AdapterError('invalid_stream', 'Messages tool stop has no tool calls')
          reported = true
          yield { type: 'usage', usage: normalizeUsage(usage, protocol) }
          yield { type: 'completed', finishReason: stopReason === 'max_tokens' ? 'length' : assistant.tool_calls?.length ? 'tool_calls' : 'stop', providerState: completeState(request, protocol, prior, output, project, provider) }
          return
        }
      }
      throw new AdapterError('incomplete_stream', 'Messages stream ended without completion')
    } catch (error) {
      if (usage && !reported) {
        try { yield { type: 'usage', usage: normalizeUsage(usage, protocol) } } catch (error) { void error }
      }
      yield failure(error, signal, options.apiKey)
    }
  }
}
