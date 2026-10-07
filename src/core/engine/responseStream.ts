import { randomUUID } from 'node:crypto'
import type OpenAI from 'openai'
import type { TokenUsage } from '../costTracker.js'
import { ThinkingTagFilter } from '../thinkingTagFilter.js'
import type { EngineObserver } from './observer.js'
import type { StreamingToolCall } from './toolPolicy.js'
import type { ProviderContinuationState } from '../model/types.js'
import type { GatewayChunk } from '../modelRuntime.js'
export interface ModelResponse {
  assistantText: string
  finishReason: string | null
  rawToolCalls: StreamingToolCall[]
  usage: TokenUsage | null
  providerState?: ProviderContinuationState
}
export async function consumeModelStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk> | (() => Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>>),
  turnAbortSignal: AbortSignal,
  renderer: EngineObserver,
  controller: AbortController | null,
): Promise<ModelResponse> {
  let assistantText = ''
  let finishReason: string | null = null
  let usage: TokenUsage | null = null
  let providerState: ProviderContinuationState | undefined
  const toolCallsMap = new Map<number, StreamingToolCall>()
  const thinkingTagFilter = new ThinkingTagFilter()
  let firstToken = true
  const emitText = (content: string): void => {
    if (!content) return
    if (firstToken) {
      renderer.stopSpinner()
      renderer.beginAssistantText()
      firstToken = false
    }
    renderer.streamToken(content)
    assistantText += content
  }
  const STREAM_TIMEOUT_MS = 120000
  let lastChunkTime = Date.now()
  const turnController = controller
  const watchdog = setInterval(() => {
    if (Date.now() - lastChunkTime > STREAM_TIMEOUT_MS) {
      if (turnController) {
        turnController.abort('timeout:model:stream')
      }
    }
  }, 10000)
  const stopWatchdog = (): void => clearInterval(watchdog)
  turnAbortSignal.addEventListener('abort', stopWatchdog, { once: true })
  try {
    const opened = typeof stream === 'function' ? await stream() : stream
    for await (const chunk of opened) {
      if (turnAbortSignal.aborted) break
      lastChunkTime = Date.now()
      providerState = (chunk as GatewayChunk).providerState ?? providerState
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        }
      }
      const delta = chunk.choices[0]?.delta
      if (!delta) continue
      if (delta.content) {
        const visibleContent = thinkingTagFilter.push(delta.content)
        const thinkingContent = thinkingTagFilter.drainThinking()
        if (thinkingContent) {
          renderer.streamReasoning?.(thinkingContent)
        }
        emitText(visibleContent)
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index
          if (!toolCallsMap.has(idx)) {
            toolCallsMap.set(idx, {
              index: idx,
              id: '',
              name: '',
              arguments: '',
            })
          }
          const acc = toolCallsMap.get(idx)!
          if (tc.id) acc.id = tc.id
          if (tc.function?.name) acc.name += tc.function.name
          if (tc.function?.arguments) acc.arguments += tc.function.arguments
        }
      }
      if (chunk.choices[0]?.finish_reason) {
        finishReason = chunk.choices[0].finish_reason
      }
    }
    turnAbortSignal.throwIfAborted()
    const trailingContent = thinkingTagFilter.finish()
    const trailingThinking = thinkingTagFilter.drainThinking()
    if (trailingThinking) {
      renderer.streamReasoning?.(trailingThinking)
    }
    emitText(trailingContent)
  } catch (err: unknown) {
    if (!turnAbortSignal.aborted) renderer.stopSpinner()
    throw err
  } finally {
    stopWatchdog()
    turnAbortSignal.removeEventListener('abort', stopWatchdog)
  }
  renderer.stopSpinner()
  if (assistantText) {
    renderer.endAssistantText()
  }
  const rawToolCalls = Array.from(toolCallsMap.values())
    .sort((a, b) => a.index - b.index)
    .map((tc) => {
      if (!tc.id) {
        tc.id = `call_${randomUUID()}`
      }
      return tc
    })
  return { assistantText, finishReason, rawToolCalls, usage, ...(providerState ? { providerState } : {}) }
}
