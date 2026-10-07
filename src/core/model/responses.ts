import type { OpenAIMessage, ToolCall } from '../types.js'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import { AdapterError, array, effortParameters, failure, imageUrl, index, normalizeUsage, parseArguments, record, text, validateRequest } from './common.js'
import { completeState, nativeTurn, ownOptions, providerIdentity, requestState, validateState, visibleText } from './state.js'
import { httpEvents } from './transport.js'
import type { AdapterOptions, ModelAdapter, ModelEvent, ModelRequest, NormalizedUsage, ProviderContinuationState } from './types.js'

function project(items: Record<string, unknown>[]): OpenAIMessage {
  let content = ''
  const calls: ToolCall[] = []
  for (const item of items) {
    if (item.type === 'message') {
      if (item.role !== 'assistant') throw new AdapterError('invalid_stream', 'Invalid Responses message role')
      for (const value of array(item.content)) {
        const part = record(value)
        if (part.type === 'output_text') content += text(part.text)
        else if (part.type === 'refusal') content += text(part.refusal)
        else throw new AdapterError('invalid_stream', 'Unsupported Responses output content')
      }
    } else if (item.type === 'function_call') {
      const id = text(item.call_id)
      const name = text(item.name)
      const args = text(item.arguments)
      if (!id || !name || calls.some(call => call.id === id)) throw new AdapterError('invalid_stream', 'Invalid Responses tool identity')
      parseArguments(args)
      calls.push({ id, type: 'function', function: { name, arguments: args } })
    } else if (item.type === 'reasoning') {
      if (!text(item.id)) throw new AdapterError('invalid_stream', 'Invalid reasoning item identity')
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) text(item.encrypted_content)
      for (const summary of array(item.summary ?? [])) { const value = record(summary); if (value.type !== 'summary_text') throw new AdapterError('invalid_stream', 'Invalid reasoning summary'); text(value.text) }
    } else throw new AdapterError('invalid_stream', 'Unsupported Responses output item')
  }
  return { role: 'assistant', content: visibleText(content), ...(calls.length ? { tool_calls: calls } : {}) }
}
function inputItems(request: ModelRequest, state: ProviderContinuationState | undefined): Record<string, unknown>[] {
  return request.messages.flatMap((message, messageIndex) => {
    const native = nativeTurn(state, messageIndex)
    if (native) return native
    if (message.role === 'tool') return [{ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.type === 'text' ? { type: 'input_text', text: part.text } : { type: 'input_image', image_url: imageUrl(part), detail: 'auto' }) }]
    const content = typeof message.content === 'string' ? [{ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: message.content }] : (message.content ?? []).map(part => part.type === 'text' ? { type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text } : { type: 'input_image', image_url: imageUrl(part), detail: 'auto' })
    const items: Record<string, unknown>[] = content.length ? [{ role: message.role, content }] : []
    for (const call of message.tool_calls ?? []) items.push({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })
    return items
  })
}
export function createResponsesAdapter(configuration: AdapterOptions): ModelAdapter {
  const options = ownOptions(configuration)
  const protocol = 'responses' as const
  const provider = providerIdentity(protocol, options)
  return { protocol, capabilities: options.capabilities, validateState: (state, model) => validateState(state, protocol, model, project, provider), stream: (request, signal) => stream(structuredClone(request), signal) }
  async function* stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    let usage: NormalizedUsage = { kind: 'unknown' }
    let reported = false
    try {
      signal.throwIfAborted()
      validateRequest(request, options)
      const prior = requestState(request, protocol, project, provider)
      const body = { model: request.model, input: inputItems(request, prior), tools: request.tools.map(tool => ({ type: 'function', ...tool.function, strict: false })), max_output_tokens: request.maxOutputTokens, stream: true, store: false, include: ['reasoning.encrypted_content'], ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...effortParameters(protocol, options.effort, request, options), ...(request.responseSchema ? { text: { format: { type: 'json_schema', name: 'response', schema: request.responseSchema, strict: true } } } : {}) }
      const items = new Map<number, Record<string, unknown>>()
      const calls = new Map<string, { id: string; name: string; arguments: string }>()
      let streamedText = ''
      const filter = new ThinkingTagFilter()
      for await (const value of httpEvents(protocol, body, options, signal)) {
        const event = record(value)
        const type = text(event.type)
        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = record(event.item)
          items.set(index(event.output_index), item)
          if (type === 'response.output_item.added' && item.type === 'function_call') {
            const id = text(item.call_id)
            const name = text(item.name)
            const itemId = text(item.id)
            if (!id || !name || calls.has(itemId)) throw new AdapterError('invalid_stream', 'Invalid Responses tool identity')
            const args = text(item.arguments ?? '')
            calls.set(itemId, { id, name, arguments: args })
            yield { type: 'toolCallDelta', callId: id, name, argumentsDelta: args }
          } else if (type === 'response.output_item.added' && item.type === 'reasoning') yield { type: 'reasoningDelta', text: '' }
        } else if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          const value = text(event.delta)
          const delta = filter.push(value)
          filter.drainThinking()
          streamedText += delta
          if (delta) yield { type: 'textDelta', text: delta }
          else if (value) yield { type: 'progress' }
        } else if (type === 'response.reasoning_text.delta' || type === 'response.reasoning_summary_text.delta') {
          if (text(event.delta)) yield { type: 'progress' }
        } else if (type === 'response.function_call_arguments.delta') {
          const item = event.item_id ? calls.get(text(event.item_id)) : calls.get(text(items.get(index(event.output_index))?.id))
          if (!item) throw new AdapterError('invalid_stream', 'Tool argument delta has no declared call')
          const delta = text(event.delta)
          item.arguments += delta
          yield { type: 'toolCallDelta', callId: item.id, argumentsDelta: delta }
        } else if (type === 'error' || type === 'response.failed') {
          const response = event.response ? record(event.response) : undefined
          if (response?.usage) usage = normalizeUsage(response.usage, protocol)
          const error = record(response?.error ?? event.error ?? event)
          throw new AdapterError(typeof error.code === 'string' ? error.code : 'provider_error', typeof error.message === 'string' ? error.message.slice(0, 1024) : 'Responses provider failed', ['server_error', 'rate_limit_exceeded', 'rate_limit_error'].includes(String(error.code)))
        } else if (type === 'response.completed' || type === 'response.incomplete') {
          const response = record(event.response)
          usage = normalizeUsage(response.usage, protocol)
          const output = response.output === undefined ? [...items.entries()].sort(([left], [right]) => left - right).map(([, item]) => item) : array(response.output).map(item => record(item))
          const assistant = project(output)
          const trailing = filter.finish(); filter.drainThinking()
          if (trailing) { streamedText += trailing; yield { type: 'textDelta', text: trailing } }
          const fullText = text(assistant.content)
          if (!fullText.startsWith(streamedText)) throw new AdapterError('invalid_stream', 'Completed response differs from streamed text')
          if (fullText.length > streamedText.length) yield { type: 'textDelta', text: fullText.slice(streamedText.length) }
          for (const call of assistant.tool_calls ?? []) {
            const streamed = [...calls.values()].find(value => value.id === call.id)
            if (streamed && (streamed.name !== call.function.name || !call.function.arguments.startsWith(streamed.arguments))) throw new AdapterError('invalid_stream', 'Completed response differs from streamed tool call')
            if (!streamed) yield { type: 'toolCallDelta', callId: call.id, name: call.function.name, argumentsDelta: call.function.arguments }
            else if (call.function.arguments.length > streamed.arguments.length) yield { type: 'toolCallDelta', callId: call.id, argumentsDelta: call.function.arguments.slice(streamed.arguments.length) }
          }
          if ([...calls.values()].some(call => !assistant.tool_calls?.some(final => final.id === call.id))) throw new AdapterError('invalid_stream', 'Completed response omitted a streamed tool call')
          if (type === 'response.incomplete' && record(response.incomplete_details ?? {}).reason !== 'max_output_tokens') throw new AdapterError('incomplete_response', 'Provider could not complete the response')
          reported = true
          yield { type: 'usage', usage }
          yield { type: 'completed', finishReason: type === 'response.incomplete' ? 'length' : assistant.tool_calls?.length ? 'tool_calls' : 'stop', providerState: completeState(request, protocol, prior, output, project, provider) }
          return
        }
      }
      throw new AdapterError('incomplete_stream', 'Responses stream ended without completion')
    } catch (error) { if (!reported && usage.kind === 'actual') yield { type: 'usage', usage }; yield failure(error, signal, options.apiKey) }
  }
}
