import { describe, expect, it, vi, type Mock } from 'vitest'
import type { AgentEvent, AgentEventInput } from '../../src/core/agentEvents.js'
import type { EngineObserver } from '../../src/core/engine/observer.js'
import { createAgentEventRenderer } from '../../src/ui/agentEventRenderer.js'

function setup() {
  const observer = Object.fromEntries(['startSpinner', 'stopSpinner', 'beginAssistantText', 'streamToken', 'streamReasoning', 'endAssistantText', 'toolStart', 'toolResult', 'contextWarning', 'compactStart', 'compactDone', 'warn', 'error'].map(name => [name, vi.fn()])) as Record<keyof EngineObserver, Mock<(...args: unknown[]) => void>>
  const project = createAgentEventRenderer(observer)
  let sequence = 0
  return { observer, emit: (input: Omit<AgentEventInput, 'turnId'>) => project({ ...input, schemaVersion: 1, sequence: ++sequence, threadId: 'thread', turnId: 'turn' } as AgentEvent) }
}

describe('terminal event rendering', () => {
  it('streams only assistant deltas and ends partial responses exactly once', () => {
    const { observer, emit } = setup()
    emit({ type: 'item.started', itemId: 'user', kind: 'message', role: 'user' } as AgentEventInput)
    emit({ type: 'item.delta', itemId: 'user', text: 'hidden echo' } as AgentEventInput)
    emit({ type: 'item.completed', itemId: 'user', kind: 'message', status: 'completed', result: 'hidden echo' } as AgentEventInput)
    emit({ type: 'item.started', itemId: 'answer', kind: 'message', role: 'assistant' } as AgentEventInput)
    emit({ type: 'item.delta', itemId: 'answer', text: 'hello 世界' } as AgentEventInput)
    emit({ type: 'item.completed', itemId: 'answer', kind: 'message', status: 'partial', result: 'hello 世界' } as AgentEventInput)
    emit({ type: 'turn.finished', status: 'cancelled', historyRevision: 1, result: { stopped: true, reason: 'interrupted', status: 'cancelled', output: 'hello 世界' } } as AgentEventInput)
    expect(observer.streamToken).toHaveBeenCalledExactlyOnceWith('hello 世界')
    expect(observer.beginAssistantText).toHaveBeenCalledOnce()
    expect(observer.endAssistantText).toHaveBeenCalledOnce()
  })

  it('matches tool completions by item identity and preserves bounded preview evidence', () => {
    const { observer, emit } = setup()
    emit({ type: 'item.started', itemId: 'one', kind: 'tool', name: 'Read', preview: '{"file_path":"one"}' } as AgentEventInput)
    emit({ type: 'item.started', itemId: 'two', kind: 'tool', name: 'Edit', preview: '{"file_path":"very long' } as AgentEventInput)
    emit({ type: 'item.completed', itemId: 'two', kind: 'tool', status: 'failed', result: { content: 'second failed', isError: true } } as AgentEventInput)
    emit({ type: 'item.completed', itemId: 'one', kind: 'tool', status: 'completed', result: { content: 'first', isError: false } } as AgentEventInput)
    expect(observer.toolStart).toHaveBeenNthCalledWith(1, 'Read', { file_path: 'one' })
    expect(observer.toolStart).toHaveBeenNthCalledWith(2, 'Edit', { preview: '{"file_path":"very long' })
    expect(observer.toolResult).toHaveBeenNthCalledWith(1, 'Edit', 'second failed', true)
    expect(observer.toolResult).toHaveBeenNthCalledWith(2, 'Read', 'first', false)
  })
})
