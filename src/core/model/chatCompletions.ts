import { randomUUID } from 'node:crypto'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import type { OpenAIMessage, ToolCall } from '../types.js'
import { abortable, AdapterError, array, effortParameters, failure, index, normalizeUsage, parseArguments, record, text, validateRequest } from './common.js'
import { completeState, nativeTurn, ownOptions, providerIdentity, requestState, validateState, visibleText } from './state.js'
import { httpEvents } from './transport.js'
import type { AdapterOptions, ModelAdapter, ModelEvent, ModelRequest, NormalizedUsage } from './types.js'

function project(items: Record<string, unknown>[]): OpenAIMessage {
  if (items.length !== 1 || items[0].role !== 'assistant') throw new AdapterError('invalid_stream', 'Invalid native Chat continuation')
  const item = items[0]
  if (Object.keys(item).some(key => !['role', 'content', 'tool_calls', 'reasoning_content', 'reasoning_details'].includes(key))) throw new AdapterError('invalid_stream', 'Unknown Chat continuation field')
  const calls = item.tool_calls === undefined ? [] : array(item.tool_calls).map(value => {
    const call = record(value)
    const fn = record(call.function)
    const id = text(call.id)
    const name = text(fn.name)
    const args = text(fn.arguments)
    if (!id || !name || call.type !== 'function') throw new AdapterError('invalid_stream', 'Invalid Chat tool call')
    parseArguments(args)
    return { id, type: 'function' as const, function: { name, arguments: args } }
  })
  if (new Set(calls.map(call => call.id)).size !== calls.length) throw new AdapterError('invalid_stream', 'Chat tool identity was repeated')
  if (item.reasoning_content !== undefined) text(item.reasoning_content)
  if (item.reasoning_details !== undefined) array(item.reasoning_details)
  return { role: 'assistant', content: visibleText(text(item.content)), ...(calls.length ? { tool_calls: calls } : {}) }
}
export function createChatCompletionsAdapter(configuration: AdapterOptions): ModelAdapter {
  const options = ownOptions(configuration)
  const protocol = 'chat-completions' as const
  const provider = providerIdentity(protocol, options)
  return { protocol, capabilities: options.capabilities, validateState: (state, model) => validateState(state, protocol, model, project, provider), stream: (request, signal) => stream(structuredClone(request), signal) }
  async function* stream(request: ModelRequest, signal: AbortSignal): AsyncGenerator<ModelEvent> {
    let usage: NormalizedUsage = { kind: 'unknown' }
    let reported = false
    try {
      signal.throwIfAborted()
      validateRequest(request, options)
      const prior = requestState(request, protocol, project, provider)
      const messages = request.messages.map((message, messageIndex) => {
        const native = nativeTurn(prior, messageIndex)
        if (native) return native[0]
        const { source: _source, providerState: _providerState, ...wire } = message
        void _source
        void _providerState
        return wire
      })
      const body = { model: request.model, messages, tools: request.tools.length ? request.tools : undefined, stream: true, stream_options: { include_usage: true }, max_tokens: request.maxOutputTokens, ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...effortParameters(protocol, options.effort, request, options), ...(request.responseSchema ? { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.responseSchema } } } : {}) }
      const supplied = options.client ? await abortable(Promise.resolve(options.client.create(body, { signal })), signal) : httpEvents(protocol, body, options, signal)
      if (!supplied || typeof supplied !== 'object' || !(Symbol.asyncIterator in supplied)) throw new AdapterError('invalid_stream', 'Expected a streaming Chat response')
      const iterator = (supplied as AsyncIterable<unknown>)[Symbol.asyncIterator]()
      const calls = new Map<number, { id?: string; name: string; arguments: string; pendingName: string; pendingArguments: string }>()
      let rawContent = ''
      let reasoning = ''
      let details: unknown[] = []
      let finish: string | undefined
      const filter = new ThinkingTagFilter()
      try {
        for (;;) {
          const next = await abortable(iterator.next(), signal)
          if (next.done) break
          const chunk = record(next.value)
          if (chunk.error) throw new AdapterError('provider_error', 'Chat provider returned an error')
          if (chunk.usage) usage = normalizeUsage(chunk.usage, protocol)
          const choices = array(chunk.choices)
          if (!choices.length) continue
          const choice = record(choices[0])
          const delta = record(choice.delta ?? {})
          if (delta.content !== undefined && delta.content !== null) {
            const value = text(delta.content)
            rawContent += value
            const visible = filter.push(value)
            filter.drainThinking()
            if (visible) yield { type: 'textDelta', text: visible }
            else if (value) yield { type: 'progress' }
          }
          if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
            const value = text(delta.reasoning_content)
            reasoning += value
            if (value) yield { type: 'progress' }
          }
          if (delta.reasoning_details !== undefined && delta.reasoning_details !== null) {
            const values = array(delta.reasoning_details)
            for (const value of values) record(value)
            details = [...details, ...values]
            if (values.length) yield { type: 'progress' }
          }
          if (delta.tool_calls) for (const value of array(delta.tool_calls)) {
            const call = record(value)
            const at = index(call.index)
            let accumulated = calls.get(at)
            if (!accumulated) { accumulated = { name: '', arguments: '', pendingName: '', pendingArguments: '' }; calls.set(at, accumulated) }
            if (call.id !== undefined) {
              const id = text(call.id)
              if (!id || accumulated.id && accumulated.id !== id || [...calls.entries()].some(([otherIndex, otherCall]) => otherIndex !== at && otherCall.id === id)) throw new AdapterError('invalid_stream', 'Tool call identity changed or was repeated during streaming')
              accumulated.id = id
            }
            const fn = record(call.function ?? {})
            if (fn.name !== undefined) { const name = text(fn.name); accumulated.name += name; accumulated.pendingName += name }
            if (fn.arguments !== undefined) { const args = text(fn.arguments); accumulated.arguments += args; accumulated.pendingArguments += args }
            if (accumulated.id && (accumulated.pendingName || accumulated.pendingArguments)) {
              yield { type: 'toolCallDelta', callId: accumulated.id, ...(accumulated.pendingName ? { name: accumulated.pendingName } : {}), argumentsDelta: accumulated.pendingArguments }
              accumulated.pendingName = ''; accumulated.pendingArguments = ''
            }
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finish = text(choice.finish_reason)
        }
      } finally { await iterator.return?.() }
      signal.throwIfAborted()
      if (!finish) throw new AdapterError('incomplete_stream', 'Chat stream ended without completion')
      if (finish === 'content_filter') throw new AdapterError('content_filter', 'Provider refused the response')
      const trailing = filter.finish(); filter.drainThinking()
      if (trailing) yield { type: 'textDelta', text: trailing }
      const toolCalls: ToolCall[] = []
      for (const [, call] of [...calls.entries()].sort(([left], [right]) => left - right)) {
        parseArguments(call.arguments)
        if (!call.name) throw new AdapterError('invalid_stream', 'Tool call has no name')
        if (!call.id) { call.id = `call_${randomUUID()}`; yield { type: 'toolCallDelta', callId: call.id, name: call.name, argumentsDelta: call.arguments } }
        toolCalls.push({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })
      }
      reported = true
      yield { type: 'usage', usage }
      const item = { role: 'assistant', content: rawContent, ...(toolCalls.length ? { tool_calls: toolCalls } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(details.length ? { reasoning_details: details } : {}) }
      yield { type: 'completed', finishReason: finish === 'length' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop', providerState: completeState(request, protocol, prior, [item], project, provider) }
    } catch (error) { if (!reported && usage.kind === 'actual') yield { type: 'usage', usage }; yield failure(error, signal, options.apiKey) }
  }
}
