/**
 * Round 3 fixes: signal cancellation, runSingleTask history, deadline
 * reentrancy, cleanup dispose. Each test drives the real helper or
 * the real InputHandler — no copied algorithms, no source-string
 * assertions.
 */

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'stream'
import { InputHandler } from '../src/ui/input.js'
import { runWithDeadline, TurnDeadlineError } from '../src/ui/turnDeadline.js'
import { trimHistoryForNextTurn } from '../src/ui/historyTrimmer.js'
import { createTerminalAskUserHandler } from '../src/tools/askUser.js'

// ── #1: AskUserQuestionHandler + InputHandler.readLine honour AbortSignal ──

describe('AbortSignal: AskUserQuestionHandler + readLine cancellation', () => {
  function makeTestHandler(): { handler: InputHandler; input: PassThrough } {
    const input = new PassThrough()
    const output = new PassThrough()
    const handler = new InputHandler({ input, output, terminal: false })
    return { handler, input }
  }
  const yieldOnce = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

  it('readLine resolves with aborted:true when signal aborts mid-question', async () => {
    const { handler } = makeTestHandler()
    const ac = new AbortController()
    const pending = handler.readLine('> ', ac.signal)
    await yieldOnce()
    ac.abort()
    const r = await pending
    expect(r.eof).toBe(true)
    expect(r.aborted).toBe(true)
  })

  it('next readLine works normally after a cancelled one (same rl)', async () => {
    const { handler, input } = makeTestHandler()
    const ac1 = new AbortController()
    const p1 = handler.readLine('> ', ac1.signal)
    await yieldOnce()
    ac1.abort()
    await p1
    // After abort, the SAME rl serves the next readLine.
    const p2 = handler.readLine('> ')
    await yieldOnce()
    input.write('hello\n')
    const r2 = await p2
    expect(r2.text).toBe('hello')
    expect(r2.aborted).toBeUndefined()
  })

  it('createTerminalAskUserHandler forwards signal to readLine; abort fills answers with sentinel', async () => {
    const { handler } = makeTestHandler()
    const baseShared = handler.sharedPrompt()
    const shared = { ...baseShared, isTTY: true }
    const askUser = createTerminalAskUserHandler({
      prompt: shared,
      writeOut: () => {},
    })
    const ac = new AbortController()
    const pending = askUser(
      [
        { question: 'Q1?', header: 'H1', options: [
          { label: 'A', description: 'a' },
          { label: 'B', description: 'b' },
        ] },
        { question: 'Q2?', header: 'H2', options: [
          { label: 'X', description: 'x' },
          { label: 'Y', description: 'y' },
        ] },
      ],
      ac.signal,
    )
    await yieldOnce()
    ac.abort()
    const out = await pending
    expect(out['Q1?']).toContain('aborted')
    expect(out['Q2?']).toContain('aborted')
  })
})

// ── #2: trimHistoryForNextTurn — what runSingleTask applies to newHistory ──

describe('trimHistoryForNextTurn', () => {
  it('keeps the trailing assistant reply and bounds the slice', () => {
    const msgs: Parameters<typeof trimHistoryForNextTurn>[0] = []
    for (let i = 0; i < 130; i++) {
      msgs.push({ role: 'user', content: `u${i}` })
      msgs.push({ role: 'assistant', content: `a${i}` })
    }
    msgs.push({ role: 'user', content: 'final' })
    msgs.push({ role: 'assistant', content: 'done' })
    const trimmed = trimHistoryForNextTurn(msgs)
    expect(trimmed[trimmed.length - 1]).toEqual({ role: 'assistant', content: 'done' })
    expect(trimmed.length).toBeLessThanOrEqual(120)
  })
})

// ── #3: deadline reentrancy via taskSettled ───────────────────────────────

describe('DeadlineHandle.taskSettled — reentrancy safety', () => {
  it('taskSettled resolves AFTER the original task finally converges', async () => {
    let inFlight = false
    const runTurn = (): Promise<{ newHistory: unknown[] }> => new Promise((resolve) => {
      inFlight = true
      setTimeout(() => {
        try {
          resolve({ newHistory: [{ role: 'assistant', content: 'partial' }] })
        } finally {
          inFlight = false
        }
      }, 50)
    })

    const dl = runWithDeadline(runTurn, { deadlineMs: 10, onDeadline: () => {} })
    let caught: unknown
    try { await dl.promise } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(TurnDeadlineError)
    const settled = await dl.taskSettled
    expect(settled.status).toBe('fulfilled')
    // By the time taskSettled resolves, the engine's `_turnInFlight`
    // is cleared — a second runTurn would NOT hit the reentrancy guard.
    expect(inFlight).toBe(false)
    const second = await runTurn()
    expect(second.newHistory.length).toBe(1)
  })

  it('without awaiting taskSettled, the second runTurn hits the reentrancy guard', async () => {
    let inFlight = false
    const runTurn = (): Promise<unknown> => {
      if (inFlight) {
        return Promise.reject(new Error('reentrancy guard: another turn is in flight'))
      }
      inFlight = true
      return new Promise((resolve) => {
        setTimeout(() => {
          try { resolve({}) } finally { inFlight = false }
        }, 50)
      })
    }

    const dl = runWithDeadline(runTurn, { deadlineMs: 10, onDeadline: () => {} })
    try { await dl.promise } catch { /* deadline fired */ }
    expect(inFlight).toBe(true)
    await expect(runTurn()).rejects.toThrow(/reentrancy guard/)
  })

  it('taskSettled surfaces the original task rejection without swallowing it', async () => {
    const err = new Error('engine boom')
    const failing = (): Promise<unknown> => Promise.reject(err)
    const dl = runWithDeadline(failing, { deadlineMs: 1_000, onDeadline: () => {} })
    try { await dl.promise } catch { /* task rejected */ }
    const settled = await dl.taskSettled
    expect(settled.status).toBe('rejected')
    if (settled.status === 'rejected') {
      expect(settled.reason).toBe(err)
    }
  })
})