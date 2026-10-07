import type { EffortLevel } from '../effort.js'
import type { OpenAIMessage, ToolDefinition } from '../types.js'

export type ModelProtocol = 'chat-completions' | 'responses' | 'anthropic'
export interface ModelCapabilities {
  tools: boolean
  vision: boolean
  reasoning: boolean
  structuredOutput: boolean
  contextWindow: number
  maxOutputTokens: number
}
export type JsonSchema = Record<string, unknown>
export interface ModelRequest {
  model: string
  messages: readonly OpenAIMessage[]
  tools: readonly ToolDefinition[]
  effort: EffortLevel
  maxOutputTokens: number
  temperature?: number
  responseSchema?: JsonSchema
  providerState?: unknown
}
export interface NormalizedUsage {
  kind: 'actual' | 'estimated' | 'unknown'
  inputTokens?: number
  cachedInputTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
  reasoningTokens?: number
}
export type ModelEvent =
  | { type: 'progress' }
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallDelta'; callId: string; name?: string; argumentsDelta: string }
  | { type: 'reasoningDelta'; text: string; providerState?: unknown }
  | { type: 'usage'; usage: NormalizedUsage }
  | { type: 'completed'; providerState?: unknown; finishReason?: 'stop' | 'tool_calls' | 'length' }
  | { type: 'failed'; code: string; message: string; retryable: boolean; retryAfterMs?: number }
export interface ProviderContinuationState {
  version: 1
  protocol: ModelProtocol
  provider: string
  model: string
  turns: Array<{ messageIndex: number; prefixDigest: string; messageDigest: string; items: Record<string, unknown>[] }>
}
export interface ModelAdapter {
  readonly protocol: ModelProtocol
  readonly capabilities: ModelCapabilities
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>
  validateState(state: unknown, model: string): ProviderContinuationState
}
export interface AdapterEffort {
  parameter: 'reasoning_effort' | 'reasoning.effort' | 'output_config.effort' | 'thinking.budget_tokens'
  values: Partial<Record<EffortLevel, string | number>>
  thinking?: 'adaptive' | 'enabled'
}
export interface ChatCompletionsTransport {
  create(body: Record<string, unknown>, options: { signal: AbortSignal }): PromiseLike<unknown> | AsyncIterable<unknown>
}
export interface AdapterOptions {
  capabilities: ModelCapabilities
  fetch?: typeof fetch
  baseURL?: string
  apiKey?: string
  effort?: AdapterEffort
  client?: ChatCompletionsTransport
}
