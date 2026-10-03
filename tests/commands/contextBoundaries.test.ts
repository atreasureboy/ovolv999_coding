import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerBuiltinCommands } from '../../src/commands/builtin.js'
import { clearRegistry, dispatchSlashCommand, getCommand, registerCommand, type SlashCommandContext } from '../../src/commands/index.js'
import { loadSchedules } from '../../src/core/cron.js'
import { parseArgs } from '../../src/cli/args.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import { Renderer } from '../../src/ui/renderer.js'
import { PassThrough } from 'node:stream'
import { getDefaultLspClient, pathToFileUri, shutdownDefaultLspClient } from '../../src/core/lspClient.js'

const directories: string[] = []
const engines: ExecutionEngine[] = []
afterEach(async () => {
  await Promise.all(engines.splice(0).map(engine => engine.dispose()))
  await shutdownDefaultLspClient()
  vi.restoreAllMocks()
  clearRegistry()
  vi.unstubAllEnvs()
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }))
})
function context(): SlashCommandContext {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-command-boundaries-'))
  directories.push(cwd)
  registerBuiltinCommands()
  const renderer = new Renderer({ stream: new PassThrough() })
  const engine = new ExecutionEngine({ cwd, apiKey: 'fixture', model: 'claude-sonnet-4', maxIterations: 1, permissionMode: 'auto', enabledModules: [] }, renderer)
  engines.push(engine)
  const ctx: SlashCommandContext = { cwd, history: [], engine, renderer, setHistory: history => { ctx.history = history }, runPrompt: () => {} }
  return ctx
}

describe('command context boundaries', () => {
  it('reports the model currently selected in the engine', async () => {
    const result = await dispatchSlashCommand('/models', context())
    expect(result).toMatchObject({ type: 'text', value: expect.stringContaining('Current model: claude-sonnet-4') })
  })

  it('extracts documentation from the active command directory', async () => {
    const ctx = context()
    mkdirSync(join(ctx.cwd, 'src'))
    writeFileSync(join(ctx.cwd, 'src', 'fixture.ts'), 'export interface AuditFixture { name: string }')
    expect(await dispatchSlashCommand('/magic-docs models', ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('AuditFixture') })
  })

  it('uses the LSP client belonging to the active command directory', async () => {
    const ctx = context()
    vi.spyOn(getDefaultLspClient(pathToFileUri(ctx.cwd)), 'isRunning').mockReturnValue(true)
    expect(await dispatchSlashCommand('/lsp', ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('Default client running: yes') })
  })

  it('scans secrets stored in tool arguments and multimodal text', async () => {
    const ctx = context()
    const secret = 'sk-' + 'A1b2C3d4'.repeat(6)
    ctx.history = [{ role: 'user', content: [{ type: 'text', text: secret }] }, { role: 'assistant', content: 'calling a tool', tool_calls: [{ id: '1', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: secret }) } }] }]
    expect(await dispatchSlashCommand('/scan', ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('2 secret') })
  })

  it.each(['/workflow run fixture', '/workflow fixture'])('runs the actual slash command inside %s', async (command) => {
    const ctx = context()
    const called = vi.fn(() => ({ type: 'text' as const, value: 'actual output' }))
    registerCommand({ name: 'workflow-fixture', description: 'fixture', handler: called })
    mkdirSync(join(ctx.cwd, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(join(ctx.cwd, '.ovolv999', 'workflows', 'fixture.json'), JSON.stringify({ name: 'fixture', steps: [{ type: 'slash', command: '/workflow-fixture' }] }))
    expect(await dispatchSlashCommand(command, ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('actual output') })
    expect(called).toHaveBeenCalledOnce()
  })

  it('reports indirect recursive workflows as failed instead of completed', async () => {
    const ctx = context()
    const command = getCommand('workflow')!
    let calls = 0
    registerCommand({ ...command, handler: (args, context) => { if (++calls > 3) throw new Error('fixture recursion safety bound'); return command.handler(args, context) } })
    mkdirSync(join(ctx.cwd, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(join(ctx.cwd, '.ovolv999', 'workflows', 'first.json'), JSON.stringify({ name: 'first', steps: [{ type: 'slash', command: '/workflow run second' }] }))
    writeFileSync(join(ctx.cwd, '.ovolv999', 'workflows', 'second.json'), JSON.stringify({ name: 'second', steps: [{ type: 'slash', command: '/workflow run first' }] }))
    expect(await dispatchSlashCommand('/workflow run first', ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('✗ failed') })
    expect(calls).toBe(3)
  })

  it('accepts the documented unquoted @every duration syntax', async () => {
    const ctx = context()
    expect(await dispatchSlashCommand('/schedule create @every 10m run tests', ctx)).toMatchObject({ type: 'text', value: expect.stringContaining('Scheduled task created') })
    expect(loadSchedules(ctx.cwd).tasks[0]).toMatchObject({ cron: '@every 10m', prompt: 'run tests' })
  })

  it('uses the documented loop limit environment variable with flag precedence', () => {
    vi.stubEnv('OVOGO_LOOP_MAX_ITERS', '4suffix')
    expect(parseArgs(['node', 'ovogo']).loopMaxIters).toBe(4)
    expect(parseArgs(['node', 'ovogo', '--loop-max-iters', '9']).loopMaxIters).toBe(9)
  })
})
