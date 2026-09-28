import { describe, expect, it } from 'vitest'
import type { OpenAIMessage } from '../src/core/types.js'
import { safeHistoryStart, settleHistory, trimHistory } from '../src/core/messageGroups.js'

const group: OpenAIMessage[] = [
  { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'Read', arguments: '{}' } }, { id: 'b', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'a', content: 'first' },
  { role: 'tool', tool_call_id: 'b', content: 'second' },
]

describe('history causal groups', () => {
  it('keeps a full call group crossing the cut', () => {
    expect(trimHistory([{ role: 'assistant', content: 'old' }, ...group], 1)).toEqual(group)
  })
  it('retains pending calls until cancellation is explicitly recorded', () => {
    const pending = [group[0], group[1]]
    expect(safeHistoryStart(pending, 0)).toBe(0)
    const restored = settleHistory([...pending, { role: 'user', content: 'next' }])
    expect(restored[2]).toMatchObject({ role: 'tool', tool_call_id: 'b' })
    expect(restored[3]).toMatchObject({ role: 'user', content: 'next' })
  })
  it('does not duplicate already settled results', () => {
    expect(settleHistory(group)).toEqual(group)
  })
})
