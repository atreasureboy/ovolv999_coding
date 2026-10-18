import { createElement } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../../../src/ui/ink/App.js'
import { createInkReplController } from '../../../src/ui/ink/replController.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import { loadProjectSettings } from '../../../src/config/settings.js'
import { createCliPermissionManager } from '../../../src/cli/permissions.js'
import { estimateTokens } from '../../../src/core/compact.js'
import type OpenAI from 'openai'
import '../../../src/commands/builtin.js'

vi.mock('../../../src/ui/ink/components/PromptInput.js', () => ({ PromptInput: () => null }))
vi.mock('../../../src/utils/inputHistory.js', () => ({ loadInputHistory: () => [], saveInputHistory: () => {} }))
vi.mock('../../../src/utils/terminalTitle.js', () => ({ initTerminalTitle: () => {}, updateTerminalTitle: () => {}, restoreTerminalTitle: () => {} }))

afterEach(() => cleanup())

it('persists Ink permission mode and deny rule for a restarted engine', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-ink-permissions-'))
  const store = new UIStore()
  const engine = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'local', maxIterations: 1, enabledModules: [], permissionMode: 'auto' }, {} as Renderer)
  const controller = createInkReplController({ cwd, store, engine, inkRenderer: {} as Renderer, skills: [], onExit: () => {} })
  try {
    await controller.dispatchSlash('/permissions mode plan')
    await controller.dispatchSlash('/permissions deny Write *')
    const persisted = loadProjectSettings(cwd).permissions
    expect(persisted).toMatchObject({ mode: 'plan', rules: [{ toolName: 'Write', ruleContent: '*', behavior: 'deny' }] })
    expect(createCliPermissionManager(persisted).check('Write', { file_path: 'marker.txt' }, false)).toBe('deny')
    await controller.release()
    let request = 0
    const model = { chat: { completions: { create: () => Promise.resolve((async function* () {
      await Promise.resolve()
      if (++request === 1) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write-marker', function: { name: 'Write', arguments: JSON.stringify({ file_path: 'marker.txt', content: 'marker' }) } }] }, finish_reason: 'tool_calls' }] }
      else yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
    })()) } } } as unknown as OpenAI
    const manager = createCliPermissionManager(loadProjectSettings(cwd).permissions)
    const restarted = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'local', maxIterations: 2, enabledModules: [], permissionMode: 'auto', permissionManager: manager }, new Proxy({}, { get: () => () => {} }) as Renderer, model)
    try {
      expect(manager.getMode()).toBe('plan')
      manager.setMode('bypassPermissions')
      const result = await restarted.runTurn('Write the fixture', [])
      expect(result.newHistory.find(message => message.name === 'Write')?.content).toContain('Permission denied')
      expect(existsSync(join(cwd, 'marker.txt'))).toBe(false)
    } finally {
      await restarted.dispose()
    }
  } finally {
    await controller.release()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('renders the shared context estimate against current model input budget after switching models', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-ink-context-'))
  const store = new UIStore()
  store.setBanner('test', 'glm-4.6')
  const engine = new ExecutionEngine({ cwd, model: 'glm-4.6', apiKey: 'local', maxIterations: 1, enabledModules: [], permissionMode: 'auto', maxContextTokens: 16384, maxOutputTokens: 2048, modelSettings: {
    'glm-4.6': { capabilities: { contextWindow: 4096, maxOutputTokens: 1024 } },
    'glm-4.5': { capabilities: { contextWindow: 8192, maxOutputTokens: 1024 } },
  } }, {} as Renderer)
  const history = [{ role: 'user' as const, content: 'x'.repeat(7000) }]
  const controller = createInkReplController({ cwd, store, engine, resumedHistory: history, inkRenderer: {} as Renderer, skills: [], onExit: () => {} })
  try {
    await controller.initialize()
    const view = render(createElement(App, { store, _version: 'test', model: engine.getModel(), skills: [], runTurn: () => Promise.resolve({ newHistory: [], reason: 'stop_sequence' }), dispatchSlash: controller.dispatchSlash, initialHistory: history, getHistory: controller.getHistory, getModelHistory: controller.getModelHistory, getContextBudget: controller.getContextBudget, maxContextTokens: 16384, cwd }))
    const tokens = estimateTokens(controller.getModelHistory())
    expect(view.lastFrame()).toContain(`${Math.round(tokens / 3072 * 100)}%`)
    const pending = controller.dispatchSlash('/model')
    await vi.waitFor(() => expect(store.getState().selectOverlay).not.toBeNull())
    store.resolveSelect('glm-4.5')
    await pending
    await vi.waitFor(() => expect(view.lastFrame()).toContain(`${Math.round(tokens / 7168 * 100)}%`))
    expect(view.lastFrame()).toContain('glm-4.5')
  } finally {
    await controller.release()
    rmSync(cwd, { recursive: true, force: true })
  }
})
