import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppProps } from '../../../src/ui/ink/App.js'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { TurnEvents } from '../../../src/core/engine/events.js'
import type { OpenAIMessage } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSessionDir, saveSession } from '../../../src/core/sessionManager.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import { runInkRepl } from '../../../src/ui/ink/runInkRepl.js'
import '../../../src/commands/builtin.js'

const rendered = vi.hoisted(() => ({
  props: null as AppProps | null,
  finish: () => {},
}))

vi.mock('ink', () => ({
  render: (element: { props: AppProps }) => {
    rendered.props = element.props
    const exit = new Promise<void>((resolve) => {
      rendered.finish = resolve
    })
    return { unmount: () => rendered.finish(), waitUntilExit: () => exit }
  },
}))

vi.mock('../../../src/ui/ink/App.js', () => ({ App: () => null }))

describe('Ink REPL conversation ownership', () => {
  let repl: Promise<void>
  let store: UIStore
  let turns: OpenAIMessage[][]
  let directory: string
  let sessionDir: string

  beforeEach(async () => {
    rendered.props = null
    store = new UIStore()
    directory = mkdtempSync(join(tmpdir(), 'ovogo-repl-history-'))
    sessionDir = createSessionDir(directory)
    turns = []
    const engine = new ExecutionEngine({ cwd: directory, sessionDir, model: 'fixture', apiKey: 'local', baseURL: 'http://127.0.0.1:1/v1', enabledModules: [], maxIterations: 1, permissionMode: 'deny' }, {} as Renderer)
    vi.spyOn(engine, 'runTurn').mockImplementation((prompt, history, _images, options) => {
        turns.push([...history])
        const turnMessages: OpenAIMessage[] = [
          { role: 'user', content: prompt },
          { role: 'assistant', content: 'Latest answer' },
        ]
        const events = new TurnEvents(options!.runId!, options!.events)
        events.message('user', prompt, 'user')
        events.message('reply', 'Latest answer', 'assistant')
        return Promise.resolve({ newHistory: [...history, ...turnMessages], turnMessages, result: { stopped: true, reason: 'stop_sequence', output: 'Latest answer' } })
    })
    repl = runInkRepl({
      store,
      engine,
      inkRenderer: {} as Renderer,
      version: 'test',
      model: 'test',
      skills: [],
      cwd: directory,
      sessionDir,
      maxContextTokens: 1000,
    })
    await vi.waitFor(() => expect(rendered.props).not.toBeNull())
  })

  afterEach(async () => {
    rendered.finish()
    await repl
    vi.restoreAllMocks()
    expect(readdirSync(join(sessionDir, 'writer.lock.owners'))).toEqual([])
    rmSync(directory, { recursive: true, force: true })
  })

  it('slash history reads the completed turn rather than the initial array', async () => {
    await rendered.props!.runTurn('Latest question', [], undefined)
    await rendered.props!.dispatchSlash('/history')
    const output = store.getState().messages.at(-1)
    expect(rendered.props!.getHistory?.()).toHaveLength(2)
    expect(output).toMatchObject({ type: 'info' })
    if (output?.type === 'info') {
      expect(output.text).toContain('Latest question')
      expect(output.text).toContain('Latest answer')
      expect(output.text).toContain('Session: 2 messages')
    }
  })

  it('clear removes completed history from the following engine turn', async () => {
    const first = await rendered.props!.runTurn('First question', [], undefined)
    await rendered.props!.dispatchSlash('/clear')
    await rendered.props!.runTurn('Next question', first.newHistory, undefined)
    expect(turns[1]).toEqual([])
  })

  it('keeps a command-generated turn when the component still holds older history', async () => {
    await rendered.props!.dispatchSlash('/review')
    await vi.waitFor(() => expect(store.getState().running).toBe(false))
    await rendered.props!.runTurn('Follow-up question', [], undefined)
    expect(turns[1]).toHaveLength(2)
    expect(turns[1][1]).toMatchObject({ role: 'assistant', content: 'Latest answer' })
  })

  it('loads saved history and model context before rendering the first prompt', async () => {
    rendered.finish()
    await repl
    const saved: OpenAIMessage[] = [{ role: 'user', content: 'saved question' }, { role: 'assistant', content: 'saved reply' }]
    saveSession(sessionDir, saved)
    rendered.props = null
    const engine = new ExecutionEngine({ cwd: directory, sessionDir, model: 'fixture', apiKey: 'local', baseURL: 'http://127.0.0.1:1/v1', enabledModules: [], maxIterations: 1, permissionMode: 'deny' }, {} as Renderer)
    repl = runInkRepl({ store, engine, inkRenderer: {} as Renderer, version: 'test', model: 'fixture', skills: [], cwd: directory, sessionDir, maxContextTokens: 1000 })
    await vi.waitFor(() => expect(rendered.props).not.toBeNull())
    expect(rendered.props!.getHistory?.()).toEqual(saved)
    expect(rendered.props!.getModelHistory?.()).toEqual(saved)
  })
})
