import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:http'
import { Renderer as TerminalRenderer } from '../../src/ui/renderer.js'
import { runPlanMode, runRepl } from '../../src/cli/repl.js'
import type { CliSessionState } from '../../src/cli/sessionState.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import { AgentEventStore } from '../../src/core/agentEventStore.js'
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
  readSessionSnapshot,
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
    sessionDir: createSessionDir(cwd),
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
  it('renders actual engine events once and retains durable tool identities', async () => {
    const { cwd, config, state, engine: unused } = setup()
    await unused.dispose()
    const chunks: string[] = []
    const stream = new PassThrough()
    stream.on('data', (chunk: Buffer) => chunks.push(chunk.toString()))
    const renderer = new TerminalRenderer({ stream })
    const tokens = vi.spyOn(renderer, 'streamToken')
    const source = join(cwd, 'readme.txt')
    writeFileSync(source, 'local read evidence')
    let requests = 0
    const provider = { chat: { completions: { create: () => Promise.resolve((async function* () {
      await Promise.resolve()
      if (requests++ === 0) yield { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'read-fixture', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: source }) } }] }, finish_reason: 'tool_calls' }] }
      else yield { choices: [{ index: 0, delta: { content: 'event-rendered answer' }, finish_reason: 'stop' }] }
    })()) } } }
    const engine = new ExecutionEngine({ ...config, maxIterations: 3 }, renderer, provider as unknown as ConstructorParameters<typeof ExecutionEngine>[2])
    io.readLine.mockResolvedValueOnce({ text: 'read the file', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, config.sessionDir)
    expect(tokens).toHaveBeenCalledExactlyOnceWith('event-rendered answer')
    expect(chunks.join('')).toContain('local read evidence')
    const session = readSessionSnapshot(config.sessionDir!)
    const events = new AgentEventStore({ sessionDir: config.sessionDir!, cwd, threadId: session.sessionId, readOnly: true })
    try {
      expect(events.snapshot().lastTurn?.status).toBe('completed')
      expect(events.snapshot().items).toContainEqual(expect.objectContaining({ kind: 'tool', toolCallId: 'read-fixture', status: 'completed' }))
    } finally { events.close(); renderer.destroy(); stream.end(); await engine.dispose() }
  })

  it('compacts only the model window while keeping original tool results in the transcript', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: 'user' as const, content: `step ${index}` },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: `read-${index}`, type: 'function' as const, function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool' as const, name: 'Read', tool_call_id: `read-${index}`, content: `${index}:` + 'original evidence '.repeat(500) },
      { role: 'assistant' as const, content: `answer ${index}` },
    ]).flat()
    saveSession(config.sessionDir!, history)
    registerBuiltinCommands()
    const turn = vi.spyOn(engine, 'runTurn').mockImplementation((prompt, window) => Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'done' }, newHistory: [...window], turnMessages: [{ role: 'user', content: prompt }, { role: 'assistant', content: 'done' }] }))
    io.readLine.mockResolvedValueOnce({ text: '/compact', eof: false }).mockResolvedValueOnce({ text: 'continue', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, config.sessionDir, history)
    expect(JSON.stringify(turn.mock.calls[0][1]).length).toBeLessThan(JSON.stringify(history).length)
    expect(loadSession(config.sessionDir!).slice(0, history.length)).toEqual(history)
  })
  it('preserves the canonical transcript when a terminal turn uses a shorter model window', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const sessionDir = config.sessionDir!
    sessions.push(sessionDir)
    const history = Array.from({ length: 160 }, (_, index) => ({ role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: `retained ${index}` }))
    saveSession(sessionDir, history)
    const turnMessages = [{ role: 'user' as const, content: 'next' }, { role: 'assistant' as const, content: 'continued' }]
    vi.spyOn(engine, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'continued' }, newHistory: [...history.slice(-120), ...turnMessages], turnMessages })
    io.readLine.mockResolvedValueOnce({ text: 'next', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, sessionDir, history)
    expect(loadSession(sessionDir)).toEqual([...history, ...turnMessages])
    await engine.dispose()
  })
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
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'done' }, newHistory: [], turnMessages: [] })
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
      expect(state).toMatchObject({ prompt: null, saveOnExit: null })
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
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'done' }, newHistory: [], turnMessages: [] })
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
    vi.spyOn(engine, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'stop_sequence', status: 'blocked', output: '' }, newHistory: [], turnMessages: [] })
    io.readLine.mockResolvedValueOnce({ text: 'start', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} })
    expect(chunks.join('')).toContain('turn is blocked')
    expect(chunks.join('')).not.toContain('Done in')
    renderer.destroy(); stream.end(); await engine.dispose()
  })
  it('routes raw readline SIGINT to cancellation and releases the listener', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const abort = vi.spyOn(engine, 'abort')
    let interruptedDuringTurn = false
    vi.spyOn(engine, 'runTurn').mockImplementation(async () => {
      io.readlines[0].emit('SIGINT')
      await vi.waitFor(() => expect(abort).toHaveBeenCalled())
      interruptedDuringTurn = true
      return { result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'cancelled fixture' }, newHistory: [], turnMessages: [] }
    })
    io.readLine.mockResolvedValueOnce({ text: 'start', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} })
    expect(interruptedDuringTurn).toBe(true)
    expect(io.readLine).toHaveBeenCalledTimes(2)
    expect(renderer.writeInterruptPrompt).not.toHaveBeenCalled()
    expect(io.readlines[0].listenerCount('SIGINT')).toBe(0)
    await engine.dispose()
  })
  it('continues from the history settled after a deadline', async () => {
    vi.useFakeTimers()
    const { cwd, config, renderer, engine, state } = setup()
    const partial = [{ role: 'user' as const, content: 'partial turn' }, { role: 'assistant' as const, content: 'saved progress' }]
    let settle!: () => void
    const turn = vi.spyOn(engine, 'runTurn')
      .mockImplementationOnce(() => new Promise((resolve) => { settle = () => resolve({ result: { stopped: true, reason: 'interrupted', output: '', status: 'interrupted' }, newHistory: partial, turnMessages: partial }) }))
      .mockResolvedValueOnce({ result: { stopped: true, reason: 'stop_sequence', output: 'done', status: 'completed' }, newHistory: partial, turnMessages: [] })
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
    const owners = join(broken, 'writer.lock.owners')
    expect(existsSync(owners) ? readdirSync(owners) : []).toEqual([])
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
        expect(context.engine.getConfig().sessionDir).toBe(resumed)
        expect(loadSession(original)).toEqual(originalHistory)
        expect(loadSession(resumed)).toEqual([
          ...resumedHistory,
          { role: 'user', content: 'continue' },
          { role: 'assistant', content: 'continued' },
        ])
        return { type: 'noop' }
      },
    })
    const turn = vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockImplementation((prompt, history) =>
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
        turnMessages: [{ role: 'user', content: prompt }, { role: 'assistant', content: 'continued' }],
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
    expect(state.getEngine?.().getConfig().sessionDir).toBe(resumed)
    expect(readdirSync(join(resumed, 'writer.lock.owners'))).toEqual([])
    await engine.dispose()
  })
  it('keeps the prompt available for explicit recovery when its event manifest is corrupt', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const saved = [{ role: 'user' as const, content: 'saved instruction' }, { role: 'assistant' as const, content: 'saved answer' }]
    saveSession(config.sessionDir!, saved)
    const eventDirectory = join(config.sessionDir!, 'agent-events')
    mkdirSync(eventDirectory)
    const manifest = join(eventDirectory, 'manifest.json')
    writeFileSync(manifest, '{corrupt')
    const turns = vi.spyOn(ExecutionEngine.prototype, 'runTurn')
    let recoveredDirectory: string | undefined
    registerBuiltinCommands()
    registerCommand({ name: 'inspect-recovery', description: 'inspect recovery', handler: (_args, context) => {
      recoveredDirectory = context.sessionDir
      expect(context.history).toEqual(saved)
      expect(context.engine.getConfig().sessionDir).toBe(recoveredDirectory)
      return { type: 'noop' }
    } })
    io.readLine.mockResolvedValueOnce({ text: '/recover --fork', eof: false }).mockResolvedValueOnce({ text: '/inspect-recovery', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, config.sessionDir, saved)
    expect(recoveredDirectory).toBeDefined()
    expect(recoveredDirectory).not.toBe(config.sessionDir)
    expect(loadSession(recoveredDirectory!)).toEqual(saved)
    expect(readFileSync(manifest, 'utf8')).toBe('{corrupt')
    expect(turns).not.toHaveBeenCalled()
  })

  it('reports a failed asynchronous history command and still accepts explicit recovery', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const saved = [{ role: 'user' as const, content: 'retained' }]
    saveSession(config.sessionDir!, saved)
    const eventDirectory = join(config.sessionDir!, 'agent-events')
    mkdirSync(eventDirectory)
    writeFileSync(join(eventDirectory, 'manifest.json'), '{corrupt')
    const errors: string[] = []
    const terminal = new Proxy(renderer, { get: (target, property) => property === 'error' ? (message: string) => errors.push(message) : Reflect.get(target, property) as unknown })
    registerBuiltinCommands()
    io.readLine.mockResolvedValueOnce({ text: '/clear', eof: false }).mockResolvedValueOnce({ text: '/recover --fork', eof: false }).mockResolvedValueOnce({ text: '/exit', eof: false })
    await runRepl(state, engine, config, terminal, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, config.sessionDir, saved)
    expect(errors.join('\n')).toMatch(/command.*corrupt/i)
    expect(state.getEngine?.().getConfig().sessionDir).not.toBe(config.sessionDir)
    expect(loadSession(config.sessionDir!)).toEqual(saved)
    expect(io.readLine).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending prompt hook before it can submit a model turn', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    let release!: () => void
    const barrier = new Promise<void>(resolve => { release = resolve })
    const hook = vi.fn(() => barrier)
    const turn = vi.spyOn(engine, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: 'unexpected' }, newHistory: [], turnMessages: [] })
    io.readLine.mockResolvedValueOnce({ text: 'waiting prompt', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    const repl = runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: hook })
    await vi.waitFor(() => expect(hook).toHaveBeenCalledOnce())
    process.stdin.emit('keypress', '', { name: 'escape' })
    release()
    await repl
    expect(turn).not.toHaveBeenCalled()
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
      expect(state).toMatchObject({ prompt: null, saveOnExit: null })
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
    expect(state).toMatchObject({ prompt: null, saveOnExit: null })
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
        turnMessages: [],
      })
    const dispose = vi.spyOn(ExecutionEngine.prototype, 'dispose').mockResolvedValue()
    io.readLine.mockResolvedValue({ text: '', eof: true })
    await runPlanMode('make a plan', engine, config, renderer, new InputHandler(), [], cwd)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose.mock.instances[0]).not.toBe(engine)
  })

  it('isolates planning records and persists only the confirmed execution into the main session', async () => {
    const { cwd, config, renderer, engine } = setup()
    const history = [{ role: 'user' as const, content: 'original question' }, { role: 'assistant' as const, content: 'original answer' }]
    const calls: Array<{ directory: string; plan: boolean; prompt: string }> = []
    vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockImplementation(function (this: ExecutionEngine, prompt, window) {
      const plan = this.isPlanMode()
      calls.push({ directory: this.getConfig().sessionDir!, plan, prompt })
      const turnMessages = [{ role: 'user' as const, content: prompt }, { role: 'assistant' as const, content: plan ? 'proposed plan' : 'executed answer' }]
      return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: plan ? 'proposed plan' : 'executed answer' }, newHistory: [...window, ...turnMessages], turnMessages })
    })
    io.readLine.mockResolvedValueOnce({ text: 'yes', eof: false })
    await runPlanMode('plan then execute', engine, { ...config, planMode: true }, renderer, new InputHandler(), history, cwd)
    expect(calls).toHaveLength(2)
    expect(calls.map(call => call.plan)).toEqual([true, false])
    expect(calls[0].directory).not.toBe(calls[1].directory)
    expect(calls[1].directory).toBe(config.sessionDir)
    expect(calls[1].prompt).toContain('plan then execute')
    expect(calls[1].prompt).toContain('proposed plan')
    expect(loadSession(calls[0].directory).at(-1)?.content).toBe('proposed plan')
    expect(loadSession(config.sessionDir!).at(-1)?.content).toBe('executed answer')
    expect(history.some(message => message.content === 'proposed plan')).toBe(false)
  })

  it('uses the resumed engine and session directory throughout one workflow', async () => {
    const { cwd, config, renderer, engine, state } = setup()
    const resumed = createSessionDir(cwd)
    sessions.push(resumed)
    registerBuiltinCommands()
    let inspected = false
    registerCommand({ name: 'inspect-active', description: 'inspect current workflow session', handler: (_args, ctx) => {
      expect(ctx.sessionDir).toBe(resumed)
      expect(ctx.engine).not.toBe(engine)
      expect(ctx.engine.getConfig().sessionDir).toBe(resumed)
      expect(ctx.engine.getEffort()).toBe('high')
      inspected = true
      return { type: 'noop' }
    } })
    mkdirSync(join(cwd, '.ovolv999', 'workflows'), { recursive: true })
    writeFileSync(join(cwd, '.ovolv999', 'workflows', 'switch.json'), JSON.stringify({ name: 'switch', steps: [
      { type: 'slash', command: `/resume ${resumed}` },
      { type: 'slash', command: '/effort high' },
      { type: 'slash', command: '/inspect-active' },
    ] }))
    io.readLine.mockResolvedValueOnce({ text: '/workflow run switch', eof: false }).mockResolvedValueOnce({ text: '', eof: true })
    await runRepl(state, engine, config, renderer, cwd, new Map(), { runUserPromptSubmit: () => {} }, undefined, config.sessionDir)
    expect(inspected).toBe(true)
    expect(engine.getEffort()).toBe('medium')
  })

  it('does not ask to execute a failed planning turn and resets progress to idle', async () => {
    const { cwd, config, renderer, engine } = setup()
    vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'error', status: 'failed', output: '' }, newHistory: [], turnMessages: [] })
    io.readLine.mockResolvedValue({ text: 'yes', eof: false })
    await runPlanMode('make a plan', engine, config, renderer, new InputHandler(), [], cwd)
    expect(io.readLine).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')).current_step).toBe('idle')
    await engine.dispose()
  })

  it('sends the approved plan in the actual execution model request', async () => {
    const { cwd, config, renderer, engine: unused } = setup()
    await unused.dispose()
    const requests: Array<{ messages: Array<{ role: string; content: unknown }> }> = []
    const plan = 'Change alpha.ts only. Preserve beta.ts and verify the parser.'
    const server = createServer((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        requests.push(JSON.parse(body))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: requests.length === 1 ? plan : 'Executed the approved plan.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10 } })}\n\ndata: [DONE]\n\n`)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing local fixture address')
    const localConfig = { ...config, baseURL: `http://127.0.0.1:${address.port}/v1`, agent: { identity: { systemPrompt: () => 'local planning fixture' }, tools: [] } }
    const engine = new ExecutionEngine(localConfig, renderer)
    io.readLine.mockResolvedValueOnce({ text: 'yes', eof: false })
    try {
      await runPlanMode('Fix the parser', engine, { ...localConfig, planMode: true }, renderer, new InputHandler(), [], cwd)
      expect(requests).toHaveLength(2)
      const input = requests[1].messages.filter(message => message.role === 'user')
      expect(input).toHaveLength(1)
      expect(input[0].content).toContain('Fix the parser')
      expect(input[0].content).toContain(plan)
      expect(loadSession(config.sessionDir!).some(message => typeof message.content === 'string' && message.content.includes(plan))).toBe(true)
    } finally {
      await engine.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('does not offer execution when a completed planning turn returned no plan', async () => {
    const { cwd, config, renderer, engine } = setup()
    const turn = vi.spyOn(ExecutionEngine.prototype, 'runTurn').mockResolvedValue({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: '  ' }, newHistory: [], turnMessages: [] })
    io.readLine.mockResolvedValueOnce({ text: 'yes', eof: false })
    await runPlanMode('make a plan', engine, config, renderer, new InputHandler(), [], cwd)
    expect(io.readLine).not.toHaveBeenCalled()
    expect(turn).toHaveBeenCalledOnce()
    expect(JSON.parse(readFileSync(join(cwd, 'ovogo_progress.json'), 'utf8')).current_step).toBe('idle')
    await engine.dispose()
  })
})
