/**
 * SnipTool — manual context pruning without LLM summarization.
 *
 * Removes old messages from conversation history and inserts a boundary
 * marker. Zero LLM cost — just array manipulation.
 *
 * Inspired by claude-code's SnipTool, adapted for ovolv999's simpler
 * message model (no UUIDs — uses `keep_recent` count instead).
 *
 * Two paths use this:
 *   1. The model calls `Snip` directly when context is high and old
 *      turns are no longer relevant.
 *   2. The user runs `/snip [N]` from the REPL — that path queues the
 *      snip onto the engine (`ExecutionEngine.queueSnip`) so the next
 *      `runTurn` applies it before the first LLM call.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class SnipTool implements Tool {
  name = 'Snip'

  /**
   * Snip mutates the live `messages` array held by `runTurn`, so it is
   * NOT concurrency-safe (two parallel Snip calls would race on the same
   * array) and DOES mutate engine state.
   */
  metadata = {
    readOnly: false,
    concurrencySafe: false,
    mutatesState: true,
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Snip',
      description:
        'Remove old messages from conversation history to free context space. ' +
        'Zero LLM cost — just removes old messages and inserts a boundary marker. ' +
        'Use when the conversation is long and old messages are no longer relevant. ' +
        'Pass keep_recent to specify how many recent messages to keep (default 10).',
      parameters: {
        type: 'object',
        properties: {
          keep_recent: {
            type: 'number',
            description:
              'Number of recent messages to keep. All older messages will be removed. Default: 10.',
          },
          reason: {
            type: 'string',
            description:
              'Brief reason for snipping (shown in boundary marker). Optional.',
          },
        },
      },
    },
  }

  execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const keepRecent =
      typeof input.keep_recent === 'number' && input.keep_recent > 0
        ? Math.floor(input.keep_recent)
        : 10
    const reason = typeof input.reason === 'string' ? input.reason : undefined

    if (!ctx.snipMessages) {
      return Promise.resolve({
        content: 'Snip is not available in this context (no message access).',
        isError: true,
      })
    }

    const result = ctx.snipMessages(keepRecent, reason)

    if (result.removed === 0) {
      return Promise.resolve({
        content: `No messages snipped — conversation has ${keepRecent} or fewer messages. Nothing to remove.`,
        isError: false,
      })
    }

    return Promise.resolve({
      content:
        `Snipped ${result.removed} old messages (~${result.tokensFreed} tokens freed). ` +
        `Kept last ${keepRecent} messages. A boundary marker was inserted so the ` +
        `model knows context was truncated.`,
      isError: false,
    })
  }
}
