import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { Renderer as TerminalRenderer } from '../../src/ui/renderer.js'
import { runPlanMode, runRepl } from '../../src/cli/repl.js'
import type { CliSessionState } from '../../src/cli/sessionState.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineConfig } from '../../src/core/types.js'
import type { Renderer } from '../../src/ui/renderer.js'
import { InputHandler } from '../../src/ui/input.js'
import { registerBuiltinCommands } from '../../src/commands/builtin.js'
import { clearRegistry, registerCommand } from '../../src/commands/index.js'
import { loadSkills } from '../../src/skills/loader.js'
import { createSkillRuntime } from '../../src/skills/runtime.js'
import { createInkReplController } from '../../src/ui/ink/replController.js'
import { UIStore } from '../../src/ui/ink/store.js'
import {
  createSessionDir,
  loadSession,
  releaseSessionOwnership,
  saveSession,
} from '../../src/core/sessionManager.js'

const io = vi.hoisted(() => ({
  readLine: vi.fn(),
  close: vi.fn(),
  readlines: [] as EventEmitter[],
}))

vi.mock('../../src/ui/input.js', () => ({
  InputHandler: class {
    readline = new EventEmitter()
    constructor() { io.readlines.push(this.readline) }
    close = io.close
    readLine = io.readLine
    getLine(): string {
      return ''
    }
    sharedPrompt() {
      return { isTTY: false, readLine: io.readLine, close: io.close }
    }
  },
}))

const dirs: string[] = []
const sessions: string[] = []
const initialKeypress = process.stdin.listeners('keypress')
const initialSigint = process.listeners('SIGINT')

afterEach(() => {
  clearRegistry()
  for (const listener of process.stdin.listeners('keypress')) {
    if (!initialKeypress.includes(listener))
      process.stdin.off('keypress', listener as (...args: unknown[]) => void)
  }
  for (const listener of process.listeners('SIGINT')) {
    if (!initialSigint.includes(listener))
      process.off('SIGINT', listener as (...args: unknown[]) => void)
  }
  vi.restoreAllMocks()
  vi.useRealTimers()
  io.close.mockReset()
  io.readLine.mockReset()
  io.readlines.length = 0
  for (const session of sessions.splice(0)) releaseSessionOwnership(session)
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-repl-lifecycle-'))
  dirs.push(cwd)
  const config: EngineConfig = {
    cwd,
    apiKey: 'offline',
    model: 'gpt-4o',
    maxIterations: 1,
    permissionMode: 'auto',
    enabledModules: [],
  }
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine(config, renderer)
  const state: CliSessionState = { prompt: null, saveOnExit: null }
  return { cwd, config, renderer, engine, state }
}

describe('terminal session resource ownership', () => {
  it.each([
    { input: 'first rejected', submitted: 'first rejected' },
    { input: '/inspect-custom first', submitted: 'Inspect first' },
    { input: '/plan first', submitted: '/plan first' },
  ])('retains the REPL after an asynchronous prompt submission rejects for $input', async ({ input: firstInput, submitted }) => {
    const { cwd, config, engine, state } = setup()
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    writeFileSync(join(cwd, '.ovogo/skills/inspect-custom.md'), 'Inspect $ARGS')
    const skills = loadSkills(cwd)
    const executed: string[] = []
    vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockImplementation((prompt) => {
      executed.push(prompt)
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'done' }, newHistory: [] })
    })
    const submissions: string[] = []
    const hookRunner = {
      runUserPromptSubmit: (prompt: string) => {
        submissions.push(prompt)
        return submissions.length === 1 ? Promise.reject(new Error('submission unavailable')) : Promise.resolve([])
      },
    }
    const chunks: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const renderer = new TerminalRenderer({ stream })
    io.readLine
      .mockResolvedValueOnce({ text: firstInput, eof: false })
      .mockResolvedValueOnce({ text: 'second accepted', eof: false })
      .mockResolvedValueOnce({ text: '', eof: true })
    try {
      await runRepl(state, engine, config, renderer, cwd, skills, hookRunner)
      expect(submissions).toEqual([submitted, 'second accepted'])
      expect(executed).toEqual(['second accepted'])
      expect(chunks.join('')).toContain('submission unavailable')
      expect(chunks.join('')).toContain('Goodbye.')
      expect(state).toEqual({ prompt: null, saveOnExit: null })
    } finally {
      renderer.destroy()
      stream.end()
      await engine.dispose()
    }
  })
  it.each(['src/core $&', ''])('invokes custom skills with the same prompt and source as Ink for arguments %s', async (args) => {
    const { cwd, config, renderer, engine, state } = setup()
    mkdirSync(join(cwd, '.ovogo/skills'), { recursive: true })
    const sourcePath = join(cwd, '.ovogo/skills/inspect-custom.md')
    writeFileSync(sourcePath, '---\ndisable-model-invocation: true\n---\nInspect $ARGS')
    const skills = loadSkills(cwd)
    const prompts: string[] = []
    vi.spyOn(engine, 'runTurn').mockImplementation((prompt) => {
      prompts.push(prompt)
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'done' }, newHistory: [] })
    })
    const cliMessages: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => cliMessages.push(chunk.toString()))
    const terminalRenderer = new TerminalRenderer({ stream })
    const hooks: string[] = []
    const slash = `/inspect-custom ${args}`.trim()
    io.readLine.mockResolvedValueOnce({ text: slash, eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, terminalRenderer, cwd, skills, { runUserPromptSubmit: (prompt) => { hooks.push(prompt) } })
    const store = new UIStore()
    const ink = createInkReplController({
      store, engine, inkRenderer: renderer, skills: [...skills.values()], cwd, onExit: () => {},
      resolveSkillInvocation: createSkillRuntime(skills).resolveSkillInvocation,
      onUserPromptSubmit: (prompt) => { hooks.push(prompt) },
    })
    expect(await ink.dispatchSlash(slash)).toBe(true)
    await vi.waitFor(() => expect(store.getState().running).toBe(false))
    const expectedPrompt = args ? `Inspect ${args}` : 'Inspect '
    expect(prompts).toEqual([expectedPrompt, expectedPrompt])
    expect(hooks).toEqual([expectedPrompt, expectedPrompt])
    expect(cliMessages.join('\n')).toContain(sourcePath)
    expect(store.getState().messages).toContainEqual(expect.objectContaining({ type: 'info', text: expect.stringContaining(sourcePath) }))
    terminalRenderer.destroy()
    stream.end()
    await engine.dispose()
  })
  it('reports blocked outcomes without a successful Done message', async () => {
    const { cwd, config, engine, state } = setup()
    const chunks: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const renderer = new TerminalRenderer({ stream })
    vi.spyOn(engine, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'stop_sequence', status: 'blocked', output: '' }, newHistory: [] })
    io.readLine.mockResolvedValueOnce({ text: 'start', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} })
    expect(chunks.join('')).toContain('blocked in')
    expect(chunks.join('')).not.toContain('Done in')
    renderer.destroy(); stream.end(); await engine.dispose()
  })
  it('routes raw readline SIGINT to cancellation and releases the listener', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const abort = vi.spyOn(engine, 'abort')
    vi.spyOn(engine, 'runTurn').mockImplementation(() => {
      io.readlines[0].emit('SIGINT')
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'cancelled fixture' }, newHistory: [] })
    })
    io.readLine.mockResolvedValueOnce({ text: 'start', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} })
    expect(abort).toHaveBeenCalledOnce()
    expect(io.readlines[0].listenerCount('SIGINT')).toBe(0)
    await engine.dispose()
  })
  it('continues from the history settled after a deadline', async () => {
    vi.useFakeTimers()
    const { cwd, config, renderer, engine, state } = setup()
    const partial = [{ role: 'user' as const, content: 'partial turn' }, { role: 'assistant' as const, content: 'saved progress' }]
    let settle!: () => void
    const turn = vi.spyOn(engine, 'runTurn')
      .mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve({ result: { stopped: true, reason: 'interrupted', output: '', status: 'interrupted' }, newHistory: partial }) }))
      .mockResolvedValueOnce({ result: { stopped: true, reason: 'stop_sequence', output: 'done', status: 'completed' }, newHistory: partial })
    vi.spyOn(engine, 'abort').mockImplementation(() => { settle() })
    io.readLine.mockResolvedValueOnce({ text: 'start', eof: false }).mockResolvedValueOnce({ text: 'continue', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    const running = runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} })
    await vi.advanceTimersByTimeAsync(600_001)
    await running
    expect(turn).toHaveBeenCalledTimes(2)
    expect(turn.mock.calls[1][1]).toEqual(partial)
    await engine.dispose()
  })

  it('releases a failed resume claim without releasing the active session', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const original = createSessionDir(cwd)
    const broken = createSessionDir(cwd)
    sessions.push(original, broken)
    saveSession(original, [{ role: 'user', content: 'original' }])
    releaseSessionOwnership(broken)
    writeFileSync(join(broken, 'history.json'), '{invalid JSON}\n')
    registerBuiltinCommands()
    io.readLine.mockResolvedValueOnce({ text: `/resume ${basename(broken)}`, eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, original, [{ role: 'user', content: 'original' }])
    expect(readdirSync(join(broken, 'writer.lock.owners'))).toEqual([])
    await engine.dispose()
  })
  it('saves subsequent turns and slash context to the resumed session', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const original = createSessionDir(cwd)
    const resumed = createSessionDir(cwd)
    sessions.push(original, resumed)
    const originalHistory = [{ role: 'user' as const, content: 'original' }]
    const resumedHistory = [{ role: 'user' as const, content: 'resumed' }]
    saveSession(original, originalHistory)
    saveSession(resumed, resumedHistory)
    releaseSessionOwnership(resumed)
    registerBuiltinCommands()
    registerCommand({
      name: 'inspect-session',
      description: 'session persistence fixture',
      handler: (_args, context) => {
        expect(context.sessionDir).toBe(resumed)
        expect(loadSession(original)).toEqual(originalHistory)
        expect(loadSession(resumed)).toEqual([
          ...resumedHistory,
          { role: 'user', content: 'continue' },
          { role: 'assistant', content: 'continued' },
        ])
        return { type: 'noop' }
      },
    })
    const turn = vi.spyOn(engine, 'runTurn').mockImplementation((prompt, history) =>
      Promise.resolve({
        result: {
          stopped: true,
          reason: 'stop_sequence',
          status: 'completed',
          output: 'continued',
        },
        newHistory: [
          ...history,
          { role: 'user', content: prompt },
          { role: 'assistant', content: 'continued' },
        ],
      }),
    )
    io.readLine
      .mockResolvedValueOnce({ text: `/resume ${basename(resumed)}`, eof: false })
      .mockResolvedValueOnce({ text: 'continue', eof: false })
      .mockResolvedValueOnce({ text: '/inspect-session', eof: false })
      .mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(
      state,
      engine,
      config,
      renderer,
      cwd,
      new Map(),
      {
        runUserPromptSubmit: () => {},
      },
      undefined,
      original,
      originalHistory,
    )
    expect(turn).toHaveBeenCalledOnce()
    expect(readdirSync(join(resumed, 'writer.lock.owners'))).toEqual([])
    await engine.dispose()
  })
  it('releases its signal and keypress handlers after repeated EOF', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    io.readLine.mockResolvedValue({ text: '', eof: true })
    for (let index = 0; index < 2; index++) {
      await runRepl(state, engine, config, renderer, cwd, new Map(), {
        runUserPromptSubmit: () => {},
      })
      expect(process.stdin.listeners('keypress')).toEqual(initialKeypress)
      expect(process.listeners('SIGINT')).toEqual(initialSigint)
      expect(state).toEqual({ prompt: null, saveOnExit: null })
    }
    await engine.dispose()
  })

  it('releases session resources when reading the prompt fails', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    io.readLine.mockRejectedValue(new Error('input unavailable'))
    await expect(
      runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }),
    ).rejects.toThrow('input unavailable')
    expect(process.stdin.listeners('keypress')).toEqual(initialKeypress)
    expect(process.listeners('SIGINT')).toEqual(initialSigint)
    expect(io.close).toHaveBeenCalled()
    expect(state).toEqual({ prompt: null, saveOnExit: null })
    await engine.dispose()
  })

  it.each(['eof', 'failure'] as const)('disposes the planning engine on %s', async (mode) => {
    const { cwd, config, renderer, engine } = setup()
    const turn = vi.spyOn(ExecutionEngine.prototype, 'runTurn')
    if (mode === 'failure') turn.mockRejectedValue(new Error('planning failed'))
    else
      turn.mockResolvedValue({
        result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'plan' },
        newHistory: [],
      })
    const dispose = vi.spyOn(ExecutionEngine.prototype, 'dispose').mockResolvedValue()
    io.readLine.mockResolvedValue({ text: '', eof: true })
    await runPlanMode('make a plan', engine, config, renderer, new InputHandler(), [], cwd)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose.mock.instances[0]).not.toBe(engine)
  })

  it('does not ask to execute a failed planning turn and resets progress to idle', async () => {
    const { cwd, config, renderer, engine } = setup()
    vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'error', status: 'failed', output: '' }, newHistory: [] })
    io.readLine.mockResolvedValue({ text: 'yes', eof: false })
    await runPlanMode('make a plan', engine, config, renderer, new InputHandler(), [], cwd)
    expect(io.readLine).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')).current_step).toBe('idle')
    await engine.dispose()
  })
})
