/**
 * InputHandler readLine listener-leak regression test.
 *
 * The previous implementation registered a per-call `rl.once('close', ...)`
 * listener that was only auto-removed when Ctrl+D fired. On the normal
 * answer path, that listener lingered for the lifetime of the readline.
 * After ~11 turns, Node printed `MaxListenersExceededWarning`, and on
 * process exit every queued listener fired against an already-settled
 * Promise.
 *
 * This test calls readLine > 20 times in a row, each time providing a
 * normal answer, and asserts that `listenerCount('close')` returns to
 * its baseline after every call. It uses a real readline backed by a
 * PassThrough stream so the question callbacks actually fire.
 *
 * Note on ordering: with terminal=false, readline delivers each
 * 'line' event to the currently-pending question callback. If input
 * is written BEFORE rl.question is called, the 'line' event fires
 * with no listener and the data is lost. So we always call readLine
 * first, yield to let the question enqueue, then write the answer.
 */

import { describe, it, expect } from 'vitest'
import { PassThrough } from 'stream'
import type { Interface } from 'readline'
import { InputHandler } from '../src/ui/input.js'

function makeTestHandler(): { handler: InputHandler; rl: Interface; input: PassThrough } {
  const input = new PassThrough()
  const output = new PassThrough()
  // terminal: false so readline treats input as non-TTY — answer on
  // newline, no fancy line-editing buffering. We let InputHandler
  // construct the readline from the streams (rather than passing a
  // pre-built readline) so the handler can recreate the readline
  // after a non-destructive abort.
  const handler = new InputHandler({ input, output, terminal: false })
  return { handler, rl: handler.readline, input }
}

/** Yield once so the readline can finish enqueuing the question. */
const yieldOnce = (): Promise<void> => new Promise<void>((r) => setImmediate(r))

describe('InputHandler.readLine — close-listener leak', () => {
  it('listenerCount("close") stays at baseline across 25 normal answers', async () => {
    const { handler, rl, input } = makeTestHandler()
    const baseline = rl.listenerCount('close')
    expect(baseline).toBeLessThanOrEqual(1)

    for (let i = 0; i < 25; i++) {
      const answer = `turn-${i}`
      // Call readLine FIRST so the question is enqueued before any
      // 'line' event can fire.
      const pending = handler.readLine('> ')
      await yieldOnce()
      input.write(answer + '\n')
      const result = await pending
      expect(result.eof).toBe(false)
      expect(result.text).toBe(answer)
      // Critical assertion: no listener accumulated from this call.
      expect(rl.listenerCount('close')).toBe(baseline)
    }
  })

  it('close listener IS added while a readLine is pending (and removed on settle)', async () => {
    const { handler, rl, input } = makeTestHandler()
    const baseline = rl.listenerCount('close')

    const pending = handler.readLine('> ')
    await yieldOnce()
    expect(rl.listenerCount('close')).toBe(baseline + 1)

    input.write('hello\n')
    const result = await pending
    expect(result.text).toBe('hello')
    // Settle path must have removed the close listener.
    expect(rl.listenerCount('close')).toBe(baseline)
  })

  it('Ctrl+D (real close) still resolves with eof:true and resolves only once', async () => {
    const { handler, rl, input } = makeTestHandler()
    const baseline = rl.listenerCount('close')

    const pending = handler.readLine('> ')
    await yieldOnce()
    expect(rl.listenerCount('close')).toBe(baseline + 1)

    // Simulate Ctrl+D by closing the readline.
    input.end()
    rl.close()
    const result = await pending
    expect(result.eof).toBe(true)
  })
})
