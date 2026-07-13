/**
 * Tests for the two real helpers extracted from bin/ovogogogo.ts.
 * No source-string assertions, no copied algorithms — just behavior.
 */

import { describe, it, expect, vi } from 'vitest'
import { runWithDeadline, TurnDeadlineError } from '../src/ui/turnDeadline.js'
import { trimHistoryForNextTurn, MAX_RECENT_HISTORY_MESSAGES } from '../src/ui/historyTrimmer.js'
import type { OpenAIMessage } from '../src/core/types.js'

// ── runWithDeadline — uses vi.useFakeTimers to actually advance the clock ──

describe('runWithDeadline', () => {
  it('resolves with the task result when the task finishes first', async () => {
    const h = runWithDeadline(() => Promise.resolve('done'), { deadlineMs: 1000, onDeadline: () => {} })
    expect(await h.promise).toBe('done')
    expect(h.didExpire).toBe(false)
    h.clear()
  })

  it('fires the deadline and invokes onDeadline when time elapses', async () => {
    vi.useFakeTimers()
    try {
      const onDeadline = vi.fn()
      const stuck: Promise<string> = new Promise(() => {})  // never resolves
      const h = runWithDeadline(() => stuck, { deadlineMs: 500, onDeadline })
      // Attach a catch handler BEFORE advancing the clock, so the
      // rejected promise has a sink for the unhandled-rejection list.
      const caught = h.promise.catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(499)
      expect(onDeadline).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2)
      const e = await caught
      expect(e).toBeInstanceOf(TurnDeadlineError)
      expect(onDeadline).toHaveBeenCalledOnce()
      expect(h.didExpire).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('handle.clear() prevents a late deadline from firing', async () => {
    vi.useFakeTimers()
    try {
      const onDeadline = vi.fn()
      const h = runWithDeadline(() => Promise.resolve(42), { deadlineMs: 200, onDeadline })
      expect(await h.promise).toBe(42)
      h.clear(); h.clear()  // idempotent
      await vi.advanceTimersByTimeAsync(500)
      expect(onDeadline).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects when the task itself rejects (no deadline fire)', async () => {
    const onDeadline = vi.fn()
    const h = runWithDeadline(() => Promise.reject(new Error('boom')), {
      deadlineMs: 60_000, onDeadline,
    })
    await expect(h.promise).rejects.toThrow('boom')
    expect(onDeadline).not.toHaveBeenCalled()
    h.clear()
  })
})

// ── trimHistoryForNextTurn — exercises the real exported function ─────────

/** Build `count` user/assistant pairs. */
function pairs(count: number): OpenAIMessage[] {
  const out: OpenAIMessage[] = []
  for (let i = 0; i < count; i++) {
    out.push({ role: 'user', content: `u${i}` })
    out.push({ role: 'assistant', content: `a${i}` })
  }
  return out
}

describe('trimHistoryForNextTurn', () => {
  it('returns short histories unchanged', () => {
    const short: OpenAIMessage[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'a' },
    ]
    expect(trimHistoryForNextTurn(short)).toEqual(short)
  })

  it('treats empty input as a no-op', () => {
    expect(trimHistoryForNextTurn([])).toEqual([])
  })

  it('walks past orphan tools at the head of the recent window', () => {
    // recentStart lands on an orphan tool; the walker advances past
    // it. Build a long history whose last MAX_RECENT messages are
    // all orphan tools.
    const msgs = pairs(MAX_RECENT_HISTORY_MESSAGES)
    for (let i = 0; i < 5; i++) {
      msgs.push({ role: 'tool', content: 'r', tool_call_id: `orphan-${i}` })
    }
    const out = trimHistoryForNextTurn(msgs)
    for (const m of out) {
      if (m.role === 'tool') expect(m.tool_call_id).toMatch(/^kept-/)
    }
  })

  it('drops orphan tool at the very tail (messages.length - 1)', () => {
    // The old `messages.length - 2` bound left a single trailing
    // orphan. With the walker going all the way, no orphan remains.
    const msgs = pairs(MAX_RECENT_HISTORY_MESSAGES)
    msgs.push({ role: 'tool', content: 'r', tool_call_id: 'tail-orphan' })
    const out = trimHistoryForNextTurn(msgs)
    expect(out.filter((m) => m.role === 'tool' && m.tool_call_id === 'tail-orphan')).toEqual([])
  })

  it('keeps a tool whose assistant-with-tool_call is also in the kept set', () => {
    const msgs = pairs(30)
    msgs.push({ role: 'user', content: 'final' })
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'tc-keep', type: 'function', function: { name: 'X', arguments: '{}' } }],
    })
    msgs.push({ role: 'tool', content: 'r', tool_call_id: 'tc-keep' })
    msgs.push({ role: 'assistant', content: 'done' })
    // Pad past the recent window.
    while (msgs.length < MAX_RECENT_HISTORY_MESSAGES + 5) {
      msgs.push({ role: 'user', content: `pad-${msgs.length}` })
      msgs.push({ role: 'assistant', content: `pad-r-${msgs.length}` })
    }
    const out = trimHistoryForNextTurn(msgs)
    expect(out.some((m) => m.role === 'tool' && m.tool_call_id === 'tc-keep')).toBe(true)
  })

  it('pinned user does not drag an orphan tool back into the slice', () => {
    // The pinned user is preserved, but the orphan tool immediately
    // after it (whose assistant is NOT in keep) must be dropped.
    const msgs = pairs(MAX_RECENT_HISTORY_MESSAGES)
    msgs.push({ role: 'user', content: 'pinned-instruction' })
    msgs.push({ role: 'tool', content: 'r', tool_call_id: 'orphan-tc' })
    const out = trimHistoryForNextTurn(msgs)
    expect(out.filter((m) => m.role === 'tool' && m.tool_call_id === 'orphan-tc')).toEqual([])
  })
})
