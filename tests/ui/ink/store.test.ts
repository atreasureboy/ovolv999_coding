import { afterEach, describe, expect, it, vi } from 'vitest'
import { UIStore } from '../../../src/ui/ink/store.js'

afterEach(() => vi.useRealTimers())

describe('UI store snapshots', () => {
  it('preserves earlier snapshots while accumulating streaming text and reasoning', () => {
    const store = new UIStore()
    const initial = store.getState()
    store.appendStreamingToken('Hello')
    const textSnapshot = store.getState()
    store.appendStreamingReasoning('Thinking')
    expect(initial.streamingText).toBe('')
    expect(initial.streamingReasoning).toBe('')
    expect(textSnapshot.streamingText).toBe('Hello')
    expect(textSnapshot.streamingReasoning).toBe('')
    expect(store.getState().streamingReasoning).toBe('Thinking')
  })

  it('publishes one complete snapshot when flushing streaming output', () => {
    const store = new UIStore()
    store.appendStreamingToken('  Answer  ')
    store.appendStreamingReasoning('Reasoning')
    const received: ReturnType<UIStore['getState']>[] = []
    store.subscribe(() => received.push(store.getState()))
    store.flushStreamingText()
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      streamingText: '',
      streamingReasoning: '',
      messages: [{ id: 1, type: 'assistant', text: 'Answer' }],
    })
  })

  it('ignores tool or agent updates aimed at a different message kind', () => {
    const store = new UIStore()
    store.addUserMessage('Question')
    const message = store.getState().messages[0]
    store.setToolResult(message.id, 'tool output', true)
    store.setAgentDone(message.id, false, 'agent summary')
    expect(store.getState().messages).toEqual([{ id: 1, type: 'user', text: 'Question' }])
  })

  it('records elapsed time when a tool started at timestamp zero', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const store = new UIStore()
    const id = store.addToolStart('Read', { path: 'file.ts' })
    vi.setSystemTime(125)
    store.setToolResult(id, 'contents', false)
    expect(store.getState().messages[0]).toMatchObject({ type: 'tool', elapsedMs: 125 })
  })
})
