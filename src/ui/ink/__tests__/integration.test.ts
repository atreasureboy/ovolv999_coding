/**
 * Integration tests: InkRenderer → UIStore data flow.
 *
 * These tests verify that every InkRenderer method correctly updates
 * the UIStore state, simulating the engine's renderer calls without
 * needing a real LLM connection.
 *
 * The InkRenderer is the critical bridge between the imperative engine
 * and the declarative React UI. If this bridge is broken, the UI won't
 * reflect what the engine is doing.
 */

import { describe, it, expect } from 'vitest'
import { UIStore } from '../store.js'
import { InkRenderer } from '../inkRenderer.js'

describe('Integration: InkRenderer → UIStore', () => {
  function setup() {
    const store = new UIStore()
    const renderer = new InkRenderer(store)
    return { store, renderer }
  }

  it('banner sets version + model in store', () => {
    const { store, renderer } = setup()
    renderer.banner('1.0.0', 'gpt-4o')
    const state = store.getState()
    expect(state.banner).toEqual({ version: '1.0.0', model: 'gpt-4o' })
  })

  it('streamToken accumulates into streamingText', () => {
    const { store, renderer } = setup()
    renderer.streamToken('Hello')
    renderer.streamToken(' ')
    renderer.streamToken('World')
    expect(store.getState().streamingText).toBe('Hello World')
  })

  it('endAssistantText flushes streaming text to a message', () => {
    const { store, renderer } = setup()
    renderer.streamToken('Response text')
    renderer.endAssistantText()
    const state = store.getState()
    expect(state.streamingText).toBe('')
    const msg = state.messages.find((m) => m.type === 'assistant')
    expect(msg).toBeDefined()
    expect(msg!.type === 'assistant' && msg!.text).toBe('Response text')
  })

  it('toolStart + toolResult creates a complete tool message', () => {
    const { store, renderer } = setup()
    renderer.toolStart('Bash', { command: 'ls' })
    let state = store.getState()
    let toolMsg = state.messages.find((m) => m.type === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.type === 'tool' && toolMsg!.name).toBe('Bash')
    expect(toolMsg!.type === 'tool' && toolMsg!.result).toBeUndefined()

    renderer.toolResult('Bash', 'file1.txt\nfile2.ts', false)
    state = store.getState()
    toolMsg = state.messages.find((m) => m.type === 'tool')
    expect(toolMsg!.type === 'tool' && toolMsg!.result).toBe('file1.txt\nfile2.ts')
    expect(toolMsg!.type === 'tool' && toolMsg!.isError).toBe(false)
  })

  it('toolResult with isError=true marks the tool message', () => {
    const { store, renderer } = setup()
    renderer.toolStart('Bash', { command: 'fail' })
    renderer.toolResult('Bash', 'command not found', true)
    const toolMsg = store.getState().messages.find((m) => m.type === 'tool')
    expect(toolMsg!.type === 'tool' && toolMsg!.isError).toBe(true)
  })

  it('multiple tool calls are tracked independently', () => {
    const { store, renderer } = setup()
    // Engine processes tools sequentially: start → result → start → result
    renderer.toolStart('Read', { file_path: 'a.ts' })
    renderer.toolResult('Read', 'content of a', false)
    renderer.toolStart('Read', { file_path: 'b.ts' })
    renderer.toolResult('Read', 'content of b', false)
    const toolMsgs = store.getState().messages.filter((m) => m.type === 'tool')
    expect(toolMsgs).toHaveLength(2)
    expect(toolMsgs[0].type === 'tool' && toolMsgs[0].result).toBe('content of a')
    expect(toolMsgs[1].type === 'tool' && toolMsgs[1].result).toBe('content of b')
  })

  it('spinner start/stop toggles spinner state', () => {
    const { store, renderer } = setup()
    renderer.startSpinner('Analyzing')
    expect(store.getState().spinnerActive).toBe(true)
    expect(store.getState().spinnerVerb).toBe('Analyzing')
    renderer.stopSpinner()
    expect(store.getState().spinnerActive).toBe(false)
  })

  it('info/success/error/warn add corresponding messages', () => {
    const { store, renderer } = setup()
    renderer.info('Info message')
    renderer.success('Success message')
    renderer.error('Error message')
    renderer.warn('Warning message')
    const msgs = store.getState().messages
    expect(msgs.find((m) => m.type === 'info' && m.text === 'Info message')).toBeDefined()
    expect(msgs.find((m) => m.type === 'success' && m.text === 'Success message')).toBeDefined()
    expect(msgs.find((m) => m.type === 'error' && m.text === 'Error message')).toBeDefined()
    expect(msgs.find((m) => m.type === 'warn' && m.text === 'Warning message')).toBeDefined()
  })

  it('agentStart + agentDone creates agent lifecycle', () => {
    const { store, renderer } = setup()
    renderer.agentStart('Research codebase', 'explore')
    let agentMsg = store.getState().messages.find((m) => m.type === 'agent')
    expect(agentMsg).toBeDefined()
    expect(agentMsg!.type === 'agent' && agentMsg!.status).toBe('running')

    renderer.agentDone('Research codebase', true)
    agentMsg = store.getState().messages.find((m) => m.type === 'agent')
    expect(agentMsg!.type === 'agent' && agentMsg!.status).toBe('done')
  })

  it('agentSummary attaches summary to last agent', () => {
    const { store, renderer } = setup()
    renderer.agentStart('Task', 'general-purpose')
    renderer.agentDone('Task', true)
    renderer.agentSummary('general-purpose', 'Task', 'Completed successfully')
    const agentMsg = store.getState().messages.find((m) => m.type === 'agent')
    expect(agentMsg!.type === 'agent' && agentMsg!.summary).toBe('Completed successfully')
  })

  it('compactStart + compactDone creates compact messages', () => {
    const { store, renderer } = setup()
    renderer.compactStart(50000)
    renderer.compactDone(50000, 15000)
    const msgs = store.getState().messages
    const start = msgs.find((m) => m.type === 'compact' && m.phase === 'start')
    const done = msgs.find((m) => m.type === 'compact' && m.phase === 'done')
    expect(start).toBeDefined()
    expect(start!.type === 'compact' && start.origTokens).toBe(50000)
    expect(done).toBeDefined()
    expect(done!.type === 'compact' && done.sumTokens).toBe(15000)
  })

  it('contextWarning adds a warning message', () => {
    const { store, renderer } = setup()
    renderer.contextWarning(80000, 100000, 0.8)
    const msg = store.getState().messages.find((m) => m.type === 'context-warning')
    expect(msg).toBeDefined()
    expect(msg!.type === 'context-warning' && msg!.pct).toBe(0.8)
  })

  it('planModeStart activates plan mode', () => {
    const { store, renderer } = setup()
    renderer.planModeStart()
    expect(store.getState().planMode).toBe(true)
  })

  it('writeInterruptPrompt activates interrupt overlay', () => {
    const { store, renderer } = setup()
    renderer.writeInterruptPrompt()
    expect(store.getState().interrupt?.active).toBe(true)
  })

  it('interruptInjected sets interrupt with feedback', () => {
    const { store, renderer } = setup()
    renderer.interruptInjected('Please be more careful')
    expect(store.getState().interrupt?.active).toBe(true)
    expect(store.getState().interrupt?.feedback).toBe('Please be more careful')
  })

  it('full conversation flow: user → stream → tool → assistant', () => {
    const { store, renderer } = setup()
    renderer.banner('1.0.0', 'test-model')

    // User message (would be added by App, not renderer)
    store.addUserMessage('List files')

    // Engine streams a response
    renderer.startSpinner('Thinking')
    renderer.streamToken('Let me check.')
    renderer.endAssistantText()

    // Engine calls a tool
    renderer.toolStart('Bash', { command: 'ls' })
    renderer.toolResult('Bash', 'file1.ts\nfile2.ts', false)

    // Engine streams final response
    renderer.streamToken('Found 2 files.')
    renderer.endAssistantText()

    renderer.stopSpinner()

    const msgs = store.getState().messages
    // user, assistant, tool, assistant = 4 messages
    expect(msgs).toHaveLength(4)
    expect(msgs[0].type).toBe('user')
    expect(msgs[1].type).toBe('assistant')
    expect(msgs[2].type).toBe('tool')
    expect(msgs[3].type).toBe('assistant')
    expect(store.getState().spinnerActive).toBe(false)
  })
})
