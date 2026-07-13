/**
 * History Trimmer — bound the conversation history sent to the LLM.
 *
 * Two operations:
 *
 * 1. **Recent window** — keep the last `MAX_RECENT_HISTORY_MESSAGES` so
 *    very long conversations don't blow the context budget.
 *
 * 2. **Orphan-tool purge** — a `tool` message at the HEAD of the
 *    recent window is an orphan (its `tool_call_id` references an
 *    assistant we just dropped). The OpenAI API rejects these with a
 *    400. The previous implementation walked forward past tool
 *    messages with `maxSplit = messages.length - 2`, which left an
 *    orphan at the very tail of the array when the trailing 1–2
 *    messages were tools. The fix walks all the way to
 *    `messages.length`.
 *
 * 3. **Final orphan pass** — a pinned user message can sit next to a
 *    tool message whose assistant-with-tool_call is NOT in the kept
 *    set. We drop those orphan tools here so a pinned user doesn't
 *    "drag" them back into the slice and trigger a 400 on the next
 *    turn.
 */

import type { OpenAIMessage } from '../core/types.js'

export const MAX_RECENT_HISTORY_MESSAGES = 120
export const MAX_PINNED_USER_MESSAGES = 12

export function trimHistoryForNextTurn(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length <= MAX_RECENT_HISTORY_MESSAGES) return [...messages]

  const keepIndexes = new Set<number>()
  let recentStart = Math.max(0, messages.length - MAX_RECENT_HISTORY_MESSAGES)

  // Walk forward past orphan tools at the head of the recent window.
  // Bound is `messages.length` (not `messages.length - 2`); the old
  // bound left an orphan at the tail when the trailing 1–2 messages
  // were tools.
  if (recentStart > 0) {
    while (recentStart < messages.length && messages[recentStart]?.role === 'tool') {
      recentStart++
    }
  }

  for (let i = recentStart; i < messages.length; i++) {
    keepIndexes.add(i)
  }

  const pinnedUserIndexes: number[] = []
  let pinnedCount = 0
  for (let i = messages.length - 1; i >= 0 && pinnedCount < MAX_PINNED_USER_MESSAGES; i--) {
    const msg = messages[i]
    if (msg.role !== 'user' || typeof msg.content !== 'string') continue
    if (msg.content.startsWith('[CONVERSATION SUMMARY')) continue
    pinnedUserIndexes.push(i)
    pinnedCount++
  }
  for (const idx of pinnedUserIndexes) keepIndexes.add(idx)

  // Final orphan-tool pass: drop any tool whose matching assistant
  // is not in the kept set. Protects against the pinned-user
  // scenario where the kept set spans an assistant-tool boundary.
  const sortedKeep = Array.from(keepIndexes).sort((a, b) => a - b)
  const assistantToolCallIds = new Set<string>()
  for (const idx of sortedKeep) {
    const msg = messages[idx]
    if (msg.role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) assistantToolCallIds.add(tc.id)
    }
  }
  for (const idx of sortedKeep) {
    const msg = messages[idx]
    if (msg.role !== 'tool' || !msg.tool_call_id) continue
    if (assistantToolCallIds.has(msg.tool_call_id)) continue
    keepIndexes.delete(idx)
  }

  return sortedKeep.filter((i) => keepIndexes.has(i)).map((i) => messages[i])
}
