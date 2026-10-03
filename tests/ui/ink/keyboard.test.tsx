import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { PromptInput } from '../../../src/ui/ink/components/PromptInput.js'
import { App } from '../../../src/ui/ink/App.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import { SelectPicker } from '../../../src/ui/ink/components/SelectPicker.js'
import { Markdown, StreamingMarkdown } from '../../../src/ui/ink/components/Markdown.js'

afterEach(() => cleanup())

describe('Ink keyboard ownership', () => {
  it('dismisses an empty picker with Escape', async () => {
    const cancel = vi.fn()
    const view = render(createElement(SelectPicker, { items: [], title: 'Empty', onSelect: () => {}, onCancel: cancel }))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('\x1b')
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce())
  })

  it('renders a complete streaming fence with the same code block as static markdown', () => {
    const text = '```ts\nconst a = 1\n\nconst b = 2\n```'
    const staticView = render(createElement(Markdown, { children: text }))
    const streamingView = render(createElement(StreamingMarkdown, { children: text }))
    expect(streamingView.lastFrame()).toBe(staticView.lastFrame())
  })
  it('uses Ctrl+R to search history and lets the overlay own Enter', async () => {
    const submitted: string[] = []
    const view = render(createElement(PromptInput, {
      onSubmit: (text) => submitted.push(text), disabled: false, skills: [], history: ['Found result'], cwd: process.cwd(),
    }))
    await vi.waitFor(() => expect(view.lastFrame()).toContain('❯'))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('draft')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('draft'))
    view.stdin.write('\x12')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('reverse-i-search'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    view.stdin.write('Found')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Found_'))
    view.stdin.write('\r')
    await vi.waitFor(() => expect(view.lastFrame()).not.toContain('reverse-i-search'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(submitted).toEqual([])
    view.stdin.write('\r')
    await vi.waitFor(() => expect(submitted).toEqual(['Found result']))
  })

  it('interrupts a running turn when Escape is pressed', async () => {
    const store = new UIStore()
    store.setRunning(true)
    let interrupted = false
    const view = render(createElement(App, {
      store, _version: 'test', model: 'test', skills: [], initialHistory: [], maxContextTokens: 100, cwd: process.cwd(),
      runTurn: () => Promise.resolve({ newHistory: [], reason: 'stop' }), dispatchSlash: () => Promise.resolve(false),
      onInterrupt: () => { interrupted = true },
    }))
    await vi.waitFor(() => expect(view.lastFrame()).toContain('turn in progress'))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('\x1b')
    await vi.waitFor(() => expect(interrupted).toBe(true))
  })
})
