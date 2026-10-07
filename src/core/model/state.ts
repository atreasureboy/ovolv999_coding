import { createHash } from 'node:crypto'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import type { OpenAIMessage } from '../types.js'
import { AdapterError, array, providerEndpoint, record, text } from './common.js'
import type { AdapterOptions, ModelProtocol, ModelRequest, ProviderContinuationState } from './types.js'

export function ownOptions(options: AdapterOptions): AdapterOptions {
  return { ...options, capabilities: Object.freeze(structuredClone(options.capabilities)), ...(options.effort ? { effort: structuredClone(options.effort) } : {}) }
}
export function providerIdentity(protocol: ModelProtocol, options: AdapterOptions): string {
  const endpoint = providerEndpoint(protocol, options)
  let normalized: string
  try { normalized = new URL(endpoint).href } catch { normalized = endpoint }
  return createHash('sha256').update(protocol).update('\0').update(normalized).digest('hex')
}
export function visibleText(value: string): string {
  const filter = new ThinkingTagFilter()
  const output = filter.push(value) + filter.finish()
  filter.drainThinking()
  return output
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function normalizedMessage(message: OpenAIMessage): Record<string, unknown> {
  const calls = (message.tool_calls ?? []).map(call => {
    const argumentsValue: unknown = (() => { try { return JSON.parse(call.function.arguments) as unknown } catch { return call.function.arguments } })()
    return { ...call, function: { ...call.function, arguments: argumentsValue } }
  })
  return { role: message.role, content: message.content ?? '', tool_calls: calls, tool_call_id: message.tool_call_id ?? null, name: message.name ?? null }
}
export function historyDigest(messages: readonly OpenAIMessage[]): string {
  return createHash('sha256').update(canonical(messages.map((message, at) => at === 0 && message.role === 'system' && message.source === 'runtime' ? { role: 'system', runtimeInstructions: true } : normalizedMessage(message)))).digest('hex')
}
export type NativeProjection = (items: Record<string, unknown>[]) => OpenAIMessage
export function validateState(value: unknown, protocol: ModelProtocol, model: string, project: NativeProjection, provider: string): ProviderContinuationState {
  try {
    const serialized = JSON.stringify(value)
    if (!serialized || Buffer.byteLength(serialized) > 16 * 1024 * 1024) throw new Error('Invalid continuation size')
    const state = record(JSON.parse(serialized) as unknown)
    if (Object.keys(state).some(key => !['version', 'protocol', 'provider', 'model', 'turns'].includes(key)) || state.version !== 1 || state.protocol !== protocol || state.provider !== provider || state.model !== model) throw new Error('Provider continuation belongs to another provider, protocol or model')
    const turns = array(state.turns)
    if (!turns.length || turns.length > 512) throw new Error('Invalid native continuation length')
    let previous = -1
    const normalized = turns.map(value => {
      const turn = record(value)
      if (Object.keys(turn).some(key => !['messageIndex', 'prefixDigest', 'messageDigest', 'items'].includes(key))) throw new Error('Unknown continuation field')
      if (!Number.isSafeInteger(turn.messageIndex) || Number(turn.messageIndex) <= previous || Number(turn.messageIndex) > 100000) throw new Error('Invalid native continuation anchor')
      previous = Number(turn.messageIndex)
      const prefixDigest = text(turn.prefixDigest)
      const messageDigest = text(turn.messageDigest)
      if (!/^[a-f0-9]{64}$/.test(prefixDigest) || !/^[a-f0-9]{64}$/.test(messageDigest)) throw new Error('Invalid native continuation digest')
      const items = array(turn.items).map(item => record(item))
      if (!items.length || items.length > 1024 || historyDigest([project(items)]) !== messageDigest) throw new Error('Native output does not match its continuation anchor')
      return { messageIndex: previous, prefixDigest, messageDigest, items }
    })
    return { version: 1, protocol, provider, model, turns: normalized }
  } catch { throw new AdapterError('invalid_provider_state', 'Native continuation is invalid for this provider, model or history') }
}
export function requestState(request: ModelRequest, protocol: ModelProtocol, project: NativeProjection, provider: string): ProviderContinuationState | undefined {
  if (request.providerState === undefined) return undefined
  const state = validateState(request.providerState, protocol, request.model, project, provider)
  for (const turn of state.turns) {
    if (turn.messageIndex >= request.messages.length || historyDigest(request.messages.slice(0, turn.messageIndex)) !== turn.prefixDigest || historyDigest([request.messages[turn.messageIndex]]) !== turn.messageDigest) throw new AdapterError('invalid_provider_state', 'Native continuation does not match the current conversation history')
  }
  return state
}
export function completeState(request: ModelRequest, protocol: ModelProtocol, prior: ProviderContinuationState | undefined, items: Record<string, unknown>[], project: NativeProjection, provider: string): ProviderContinuationState {
  const state: ProviderContinuationState = { version: 1, protocol, provider, model: request.model, turns: [...(prior?.turns ?? []), { messageIndex: request.messages.length, prefixDigest: historyDigest(request.messages), messageDigest: historyDigest([project(items)]), items: structuredClone(items) }] }
  return validateState(state, protocol, request.model, project, provider)
}
export function nativeTurn(state: ProviderContinuationState | undefined, messageIndex: number): Record<string, unknown>[] | undefined { return state?.turns.find(turn => turn.messageIndex === messageIndex)?.items }
