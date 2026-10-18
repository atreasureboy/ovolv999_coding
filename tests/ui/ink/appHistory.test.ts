import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { App } from '../../../src/ui/ink/App.js'
import type { PromptInputProps } from '../../../src/ui/ink/components/PromptInput.js'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { TurnEvents } from '../../../src/core/engine/events.js'
import type { OpenAIMessage } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import { createInkReplController, type InkReplController } from '../../../src/ui/ink/replController.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import '../../../src/commands/builtin.js'

const input = vi.hoisted(() => ({
  props: null as PromptInputProps | null,
  copied: [] as string[],
}))

vi.mock('../../../src/ui/ink/components/PromptInput.js', () => ({
  PromptInput: (props: PromptInputProps) => {
    input.props = props
    return null
  },
}))
vi.mock('../../../src/utils/clipboard.js', () => ({
  copyToClipboard: (value: string) => {
    input.copied.push(value)
    return true
  },
}))
vi.mock('../../../src/utils/inputHistory.js', () => ({
  loadInputHistory: () => [],
  saveInputHistory: () => {},
}))
vi.mock('../../../src/utils/terminalTitle.js', () => ({
  initTerminalTitle: () => {},
  updateTerminalTitle: () => {},
  restoreTerminalTitle: () => {},
}))

describe('App conversation history contract', () => {
  let directory: string
  let store: UIStore
  let controllers: InkReplController[]
  const initialHistory: OpenAIMessage[] = [
    { role: 'user', content: 'old' },
    { role: 'assistant', content: 'Earlier reply' },
  ]

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-app-history-'))
    input.props = null
    input.copied = []
    store = new UIStore()
    controllers = []
  })

  afterEach(async () => {
    cleanup()
    for (const controller of controllers) await controller.release()
    vi.restoreAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  function mount(useControllerHistory = true, modelHistory?: OpenAIMessage[]) {
    const turns: OpenAIMessage[][] = []
    const engine = new ExecutionEngine({ cwd: directory, model: 'fixture', apiKey: 'local', baseURL: 'http://127.0.0.1:1/v1', enabledModules: [], maxIterations: 1, permissionMode: 'deny' }, {} as Renderer)
    vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockImplementation((_prompt, history, _images, options) => {
        turns.push([...history])
        const turnMessages: OpenAIMessage[] = [
            { role: 'user', content: 'Latest question' },
            { role: 'assistant', content: 'Latest command reply' },
        ]
        if (options?.events) {
          const events = new TurnEvents(options.runId!, options.events)
          events.message('user', 'Latest question', 'user')
          events.message('reply', 'Latest command reply', 'assistant')
        } else store.addAssistantMessage('Latest command reply')
        return Promise.resolve({
          newHistory: [...history, ...turnMessages], turnMessages,
          result: { stopped: true, reason: 'stop_sequence', output: 'Latest command reply' },
        })
    })
    const controller = createInkReplController({
      store,
      engine,
      inkRenderer: {} as Renderer,
      skills: [],
      cwd: directory,
      resumedHistory: initialHistory,
      onExit: () => {},
    })
    controllers.push(controller)
    const props = {
      store,
      _version: 'test',
      model: 'test',
      skills: [],
      initialHistory,
      maxContextTokens: 100,
      cwd: directory,
      displayUserViaEvents: useControllerHistory,
      runTurn: (prompt: string, history: OpenAIMessage[]) =>
        useControllerHistory
          ? controller.runTurn(prompt)
          : engine.runTurn(prompt, history).then(({ newHistory, result }) => ({
              newHistory,
              reason: result.reason,
            })),
      dispatchSlash: controller.dispatchSlash,
      ...(useControllerHistory ? { getHistory: controller.getHistory } : {}),
      ...(modelHistory ? { getModelHistory: () => modelHistory } : {}),
    }
    return { controller, turns, view: render(createElement(App, props)) }
  }

  async function submit(text: string): Promise<void> {
    await vi.waitFor(() => expect(input.props).not.toBeNull())
    input.props!.onSubmit(text)
    await vi.waitFor(() => expect(store.getState().running).toBe(false))
  }

  it('shows current message and token counts after a command-generated turn', async () => {
    const { controller, view } = mount()
    await submit('/review')
    await vi.waitFor(() => expect(controller.getHistory()).toHaveLength(4))
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('Latest command reply')
      expect(view.lastFrame()).toContain('4 msgs')
      expect(view.lastFrame()).toContain('57/100')
    })
  })

  it('copies the current controller reply after a command-generated turn', async () => {
    const { controller } = mount()
    await vi.waitFor(() => expect(input.props).not.toBeNull())
    const copy = input.props!.onCopy
    await submit('/review')
    await vi.waitFor(() => expect(controller.getHistory()).toHaveLength(4))
    copy?.()
    expect(input.copied).toEqual(['Latest command reply'])
  })

  it('keeps standalone App turn and copy behavior without a history getter', async () => {
    const { turns, view } = mount(false)
    await submit('Question')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('4 msgs'))
    input.props!.onCopy?.()
    expect(input.copied).toEqual(['Latest command reply'])
    expect(turns[0]).toEqual(initialHistory)
    await submit('Follow-up')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('6 msgs'))
    expect(turns[1]).toHaveLength(4)
    expect(turns[1].at(-1)).toMatchObject({ content: 'Latest command reply' })
  })

  it('shows model-window tokens while counting the full conversation', async () => {
    const { view } = mount(true, [{ role: 'assistant', content: '12345678' }])
    await vi.waitFor(() => {
      expect(view.lastFrame()).toContain('2 msgs')
      expect(view.lastFrame()).toContain('14/100')
    })
  })
})
