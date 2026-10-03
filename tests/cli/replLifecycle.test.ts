import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPlanMode, runRepl } from '../../src/cli/repl.js'
import type { CliSessionState } from '../../src/cli/sessionState.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineConfig } from '../../src/core/types.js'
import type { Renderer } from '../../src/ui/renderer.js'
import { InputHandler } from '../../src/ui/input.js'
import { registerBuiltinCommands } from '../../src/commands/builtin.js'
import { clearRegistry, registerCommand } from '../../src/commands/index.js'
import {
  createSessionDir,
  loadSession,
  releaseSessionOwnership,
  saveSession,
} from '../../src/core/sessionManager.js'

const io = vi.hoisted(() => ({
  readLine: vi.fn(),
  close: vi.fn(),
}))

vi.mock('../../src/ui/input.js', () => ({
  InputHandler: class {
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
  io.close.mockReset()
  io.readLine.mockReset()
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
})
