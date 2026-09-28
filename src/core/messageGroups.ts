import type { OpenAIMessage } from './types.js'

export function safeHistoryStart(messages: OpenAIMessage[], keepRecent: number): number {
  if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) throw new Error('keepRecent must be a finite non-negative integer')
  let start = Math.max(0, messages.length - keepRecent)
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'user' && !messages[index].source) { start = Math.min(start, index); break }
  }
  for (let index = 0; index < messages.length; index++) {
    const calls = messages[index].tool_calls
    if (!calls?.length) continue
    const pending = new Set(calls.map(call => call.id))
    let end = index + 1
    while (end < messages.length && messages[end].role === 'tool') {
      pending.delete(messages[end].tool_call_id ?? '')
      end++
    }
    if (pending.size || (index < start && end > start)) start = Math.min(start, index)
  }
  return start
}

export function trimHistory(messages: OpenAIMessage[], keepRecent: number): OpenAIMessage[] {
  return messages.slice(safeHistoryStart(messages, keepRecent))
}

export function settleHistory(messages: OpenAIMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  const pending = new Map<string, string>()
  const flush = (): void => {
    for (const [id, name] of pending) result.push({ role: 'tool', tool_call_id: id, name, content: 'Cancelled: the previous run ended before this tool call settled.', source: 'runtime' })
    pending.clear()
  }
  for (const message of messages) {
    if (message.role !== 'tool') flush()
    if (message.role === 'tool') {
      if (!message.tool_call_id || !pending.has(message.tool_call_id)) {
        result.push({ role: 'system', source: 'runtime', content: `Recovered unmatched tool result (${message.name ?? 'unknown'}): ${JSON.stringify(message.content)}` })
        continue
      }
      pending.delete(message.tool_call_id)
    }
    result.push({ ...message })
    for (const call of message.tool_calls ?? []) pending.set(call.id, call.function.name)
  }
  flush()
  return result
}
