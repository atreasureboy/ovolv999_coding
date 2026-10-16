import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionCommands } from '../../src/commands/sessionCommands.js'
import type { SlashCommandContext } from '../../src/commands/index.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { Renderer } from '../../src/ui/renderer.js'

const directories: string[] = []
const engines: ExecutionEngine[] = []

afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.dispose()))
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function context(): SlashCommandContext {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-context-window-'))
  directories.push(cwd)
  const renderer = new Proxy({}, { get: () => () => {} }) as Renderer
  const engine = new ExecutionEngine({ cwd, apiKey: 'offline', model: 'fixture', maxIterations: 1, permissionMode: 'deny', enabledModules: [], maxContextTokens: 16384, maxOutputTokens: 1024, modelSettings: { fixture: { capabilities: { contextWindow: 4096 } } } }, renderer)
  engines.push(engine)
  return { cwd, engine, renderer, history: [{ role: 'user', content: 'archived evidence '.repeat(1000) }, { role: 'assistant', content: 'old reply' }], getModelHistory: () => [{ role: 'user', content: 'summary' }], setHistory: () => {}, runPrompt: () => {} }
}

describe('context commands after model-window projection', () => {
  it.each(['context', 'status'])('uses the active model projection and input budget in /%s', async name => {
    const ctx = context()
    const before = structuredClone(ctx.history)
    const result = await sessionCommands.find(command => command.name === name)!.handler('1', ctx)
    if (result.type !== 'text') throw new Error('Expected context output')
    expect(result.value).toMatch(/12\s*\/\s*3,072/)
    expect(result.value).toContain('Model messages: 1')
    expect(result.value).toContain('Saved messages: 2')
    expect(result.value).not.toContain('archived evidence')
    if (name === 'context') expect(result.value).toContain('summary')
    expect(ctx.history).toEqual(before)
  })

  it('renders an over-budget projection without a negative progress-bar width', async () => {
    const ctx = context()
    ctx.getModelHistory = () => [{ role: 'user', content: 'x'.repeat(14000) }]
    const result = await sessionCommands.find(command => command.name === 'context')!.handler('', ctx)
    expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('130.5%') })
  })

  it('uses history when an older caller has no separate projection', async () => {
    const ctx = context()
    delete ctx.getModelHistory
    ctx.history = [{ role: 'user', content: 'summary' }]
    const result = await sessionCommands.find(command => command.name === 'context')!.handler('', ctx)
    expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('12 / 3,072') })
  })
})
