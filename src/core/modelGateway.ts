import type OpenAI from 'openai'
import { clampMaxOutputTokens, estimateTokens, estimateToolDefinitionTokens, resolveContextWindow } from './compact.js'
import type { EngineConfig, OpenAIMessage } from './types.js'
import type { RunContext } from './runContext.js'
import { runOperation } from './runContext.js'

export function createModelGateway(client: OpenAI, config: EngineConfig, currentRun: () => RunContext | null): OpenAI {
  const original = client.chat.completions.create.bind(client.chat.completions)
  const create = (async (params: OpenAI.Chat.ChatCompletionCreateParams, options?: OpenAI.RequestOptions) => {
    const run = currentRun()
    const signal = options?.signal ?? run?.controller.signal
    signal?.throwIfAborted()
    const model = params.model
    const window = resolveContextWindow(model, config.maxContextTokens)
    const maxTokens = clampMaxOutputTokens(params.max_tokens, window)
    const messages = params.messages.map(message => {
      const wire = { ...message } as OpenAIMessage
      delete wire.source
      return wire
    })
    const estimated = estimateTokens(messages) + estimateToolDefinitionTokens(params.tools)
    if (estimated + maxTokens > window) throw new Error(`Context budget exceeded before request: estimated ${estimated} input + ${maxTokens} reserved output > ${window}`)
    config.eventLog?.append('module_flag', 'model_request', { run_id: run?.runId, model, input_tokens_estimated: estimated, output_reserved: maxTokens, usage: 'unknown' })
    const send = () => Promise.resolve(original({ ...params, messages: messages as OpenAI.Chat.ChatCompletionMessageParam[], max_tokens: maxTokens }, { ...options, signal, maxRetries: 0 }))
    return run ? runOperation(run, 'model:' + model, send, 120_000, config.cancellationGraceMs ?? 2000) : send()
  }) as typeof client.chat.completions.create
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'chat') return { ...target.chat, completions: { ...target.chat.completions, create } }
      const value: unknown = Reflect.get(target, property, receiver)
      return value
    },
  })
}
