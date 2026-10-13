import { describe, expect, it } from 'vitest'
import type { AgentEventInput } from '../../../src/core/agentEvents.js'
import { InkRenderer } from '../../../src/ui/ink/inkRenderer.js'
import { UIStore } from '../../../src/ui/ink/store.js'

type EventPayload<T> = T extends { turnId: string } ? Omit<T, 'turnId'> : never

function fixture() {
  const store = new UIStore()
  const renderer = new InkRenderer(store)
  let sequence = 0
  const emit = (event: EventPayload<AgentEventInput>) => {
    renderer.agentEvent({ ...event, schemaVersion: 1, sequence: ++sequence, threadId: 'thread', turnId: 'turn' })
  }
  return { store, renderer, emit }
}

describe('Ink durable event projection', () => {
  it('pairs parallel same-name tool results by item identity', () => {
    const { store, emit } = fixture()
    emit({ type: 'item.started', kind: 'tool', itemId: 'one', name: 'Read', preview: '{"file_path":"one.txt"}' })
    emit({ type: 'item.started', kind: 'tool', itemId: 'two', name: 'Read', preview: '{"file_path":"two.txt"}' })
    emit({ type: 'item.completed', kind: 'tool', itemId: 'one', status: 'completed', result: { content: 'first result', isError: false } })
    emit({ type: 'item.completed', kind: 'tool', itemId: 'two', status: 'failed', result: { content: 'second error', isError: true } })
    expect(store.getState().messages).toMatchObject([
      { type: 'tool', input: { file_path: 'one.txt' }, result: 'first result', isError: false },
      { type: 'tool', input: { file_path: 'two.txt' }, result: 'second error', isError: true },
    ])
  })

  it('keeps complete streamed text when the terminal preview is truncated', () => {
    const { store, emit } = fixture()
    emit({ type: 'item.started', kind: 'message', itemId: 'reply', role: 'assistant' })
    emit({ type: 'item.delta', itemId: 'reply', text: 'answer 🙂\n' })
    emit({ type: 'item.delta', itemId: 'reply', text: 'continued' })
    expect(store.getState().streamingText).toBe('answer 🙂\ncontinued')
    emit({ type: 'item.completed', kind: 'message', itemId: 'reply', status: 'partial', result: 'answer', truncated: true })
    expect(store.getState().messages).toMatchObject([{ type: 'assistant', text: 'answer 🙂\ncontinued' }])
    expect(store.getState().streamingText).toBe('')
  })

  it('preserves raw user text once while showing later steering messages', () => {
    const { store, renderer, emit } = fixture()
    renderer.setUserPrompt('read @one.txt')
    emit({ type: 'item.started', kind: 'message', itemId: 'user', role: 'user' })
    emit({ type: 'item.delta', itemId: 'user', text: 'read @one.txt\nexpanded file body' })
    emit({ type: 'item.completed', kind: 'message', itemId: 'user', status: 'completed', result: 'expanded' })
    emit({ type: 'item.started', kind: 'message', itemId: 'steer', role: 'user', expectedTurnId: 'turn' })
    emit({ type: 'item.delta', itemId: 'steer', text: 'also inspect two' })
    emit({ type: 'item.completed', kind: 'message', itemId: 'steer', status: 'completed', result: 'also inspect two' })
    expect(store.getState().messages).toMatchObject([{ type: 'user', text: 'read @one.txt' }, { type: 'user', text: 'also inspect two' }])
  })

  it('retains a visible preview when a large input is not complete JSON', () => {
    const { store, emit } = fixture()
    emit({ type: 'item.started', kind: 'tool', itemId: 'edit', name: 'Edit', preview: '{"file_path":"one.txt","old_string":"large' })
    expect(store.getState().messages).toMatchObject([{ type: 'tool', input: { preview: '{"file_path":"one.txt","old_string":"large' } }])
  })
})
