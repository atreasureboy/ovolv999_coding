import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'os'
import { join, resolve } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { integrationsCommands } from '../../src/commands/integrationsCommands.js'
import type { SlashCommandContext } from '../../src/commands/index.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import { HookService } from '../../src/core/hookService.js'
import { loadHooksConfig } from '../../src/core/hooks.js'
import type { Renderer } from '../../src/ui/renderer.js'

const state = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async importOriginal => ({ ...await importOriginal<typeof Os>(), homedir: () => state.home }))
const engines: ExecutionEngine[] = []
const directories: string[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('persists /hooks configuration and applies its denial after constructing a new runtime', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-hooks-runtime-'))
  state.home = join(cwd, 'home')
  directories.push(cwd)
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const command = integrationsCommands.find(command => command.name === 'hooks')!
  const quoted = (value: string) => '"' + value + '"'
  const context = { cwd, renderer } as SlashCommandContext
  await command.handler(`add PreToolUse Write ${quoted(process.execPath)} ${quoted(resolve('scripts/fixtures/hook-runtime.mjs'))} deny`, context)
  expect(loadHooksConfig().PreToolUse).toHaveLength(1)
  let calls = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    if (++calls === 1) yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: {
      name: 'Write', arguments: JSON.stringify({ file_path: 'protected.txt', content: 'changed' }),
    } }] }, finish_reason: 'tool_calls' }] }
    else yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
  })()) } } } as unknown as OpenAI
  const engine = new ExecutionEngine({
    cwd, model: 'offline-model', apiKey: 'offline', permissionMode: 'auto', maxIterations: 2,
    enabledModules: [], hookRunner: new HookService({}, cwd),
  }, renderer, client)
  engines.push(engine)
  const { result, newHistory } = await engine.runTurn('write protected file', [])
  expect(result.status).toBe('blocked')
  expect(existsSync(join(cwd, 'protected.txt'))).toBe(false)
  expect(newHistory.find(message => message.role === 'tool')?.content).toContain('protected file')
})
