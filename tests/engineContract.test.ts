import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import type OpenAI from 'openai'
import { ExecutionEngine } from '../src/core/engine.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { globalModuleRegistry } from '../src/core/moduleRegistry.js'
import { BashTool } from '../src/tools/bash.js'
import type { EngineConfig, Tool, ToolContext } from '../src/core/types.js'
import type { Renderer } from '../src/ui/renderer.js'

const dirs: string[] = []
const engines: ExecutionEngine[] = []
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function setup(steps: Array<{ text?: string; finish?: string | null; calls?: Array<{ name: string; id?: string; input?: Record<string, unknown> }> }>, overrides: Partial<EngineConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-contract-'))
  dirs.push(cwd)
  const requests: Record<string, unknown>[] = []
  const client = { chat: { completions: { create: (params: Record<string, unknown>) => {
    requests.push(params)
    const step = steps.shift() ?? { text: 'answer', finish: 'stop' }
    return Promise.resolve((async function* () {
      await Promise.resolve()
      yield { choices: [{ delta: {
        content: step.text,
        tool_calls: step.calls?.map((call, index) => ({ index, id: call.id ?? `call-${requests.length}-${index}`, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })),
      }, finish_reason: step.finish === undefined ? (step.calls ? 'tool_calls' : 'stop') : step.finish }] }
    })())
  } } } } as unknown as OpenAI
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({ cwd, model: 'gpt-4o', apiKey: 'offline', maxIterations: 8, permissionMode: 'auto', enabledModules: [], ...overrides }, renderer, client)
  engines.push(engine)
  return { cwd, engine, requests }
}

function tool(name: string, execute: Tool['execute'], safe = false): Tool {
  return { name, metadata: { concurrencySafe: safe, readOnly: safe }, definition: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }, execute }
}

describe('engine behavioral contract', () => {
  it('settles duplicate provider call IDs with unique matching protocol results', async () => {
    const execute = vi.fn(() => Promise.resolve({ content: 'read', isError: false }))
    const { engine } = setup([{ calls: [{ name: 'Inspect', id: 'duplicate' }, { name: 'Inspect', id: 'duplicate' }] }], { extraTools: [tool('Inspect', execute, true)] })
    const { newHistory } = await engine.runTurn('inspect twice', [])
    const calls = newHistory.flatMap(message => message.tool_calls ?? [])
    const results = newHistory.filter(message => message.role === 'tool')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(new Set(calls.map(call => call.id)).size).toBe(2)
    expect(results.map(result => result.tool_call_id).sort()).toEqual(calls.map(call => call.id).sort())
  })
  it('serializes mutating tools even when their legacy concurrency flag is true', async () => {
    let active = 0
    let maxActive = 0
    const stateful = tool('Stateful', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 10))
      active--
      return { content: 'done', isError: false }
    })
    stateful.metadata = { mutatesState: true, concurrencySafe: true }
    const { engine } = setup([{ calls: [{ name: 'Stateful' }, { name: 'Stateful' }] }], { extraTools: [stateful] })
    await engine.runTurn('execute both', [])
    expect(maxActive).toBe(1)
  })
  it('requires an actual approval channel when exiting plan mode through the Engine', async () => {
    const { engine } = setup([{ calls: [{ name: 'ExitPlanMode', input: { plan: 'write files' } }] }], { planMode: true })
    expect((await engine.runTurn('approve plan', [])).result.status).toBe('needs_input')
    expect(engine.isPlanMode()).toBe(true)
  })

  it('reflects permission manager plan transitions in the next request', async () => {
    const permissionManager = new PermissionManager()
    const { engine, requests } = setup([], { permissionManager })
    permissionManager.setMode('plan')
    expect(engine.isPlanMode()).toBe(true)
    await engine.runTurn('analyze', [])
    const defs = requests[0].tools as Array<{ function: { name: string } }>
    expect(defs.some(def => def.function.name === 'Write')).toBe(false)
    expect((requests[0].messages as Array<{ content: string }>)[0].content).toContain('PLAN MODE')
    permissionManager.setMode('default')
    expect(engine.isPlanMode()).toBe(false)
  })
  it('does not accept native file writes omitted from the artifact inventory', async () => {
    const { engine, cwd } = setup([{ calls: [{ name: 'Write', input: { file_path: 'dist/ignored.txt', content: 'changed' } }] }])
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    writeFileSync(join(cwd, '.gitignore'), 'dist/\n')
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
    const { result } = await engine.runTurn('write the artifact', [])
    expect(readFileSync(join(cwd, 'dist', 'ignored.txt'), 'utf8')).toBe('changed')
    expect(result.status).toBe('blocked')
    expect(result.verification?.status).toBe('not_run')
  })
  it('does not execute ask rules without an approval channel', async () => {
    const permissionManager = new PermissionManager()
    permissionManager.addRule({ toolName: 'Touch', ruleContent: '*', behavior: 'ask', source: 'user' })
    const execute = vi.fn(() => Promise.resolve({ content: 'changed', isError: false }))
    const { engine } = setup([{ calls: [{ name: 'Touch' }] }], { permissionManager, extraTools: [tool('Touch', execute)] })
    const { result } = await engine.runTurn('do it', [])
    expect(execute).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'needs_input', verification: { status: 'not_run' } })
  })

  it('rejects a write in the same batch after entering plan mode and refreshes the next request', async () => {
    const { cwd, engine, requests } = setup([{ calls: [{ name: 'EnterPlanMode' }, { name: 'Write', input: { file_path: 'new.txt', content: 'unsafe' } }] }])
    const { newHistory } = await engine.runTurn('plan first', [])
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
    expect(newHistory.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('plan mode'))).toBe(true)
    const defs = requests.at(-1)?.tools as Array<{ function: { name: string } }>
    expect(defs.some(d => d.function.name === 'Write')).toBe(false)
    expect(String((requests.at(-1)?.messages as Array<{content: string}>)[0].content)).toContain('PLAN MODE')
  })

  it('uses custom identity plan mode and does not share mutable config arrays', async () => {
    const source: Partial<EngineConfig> = { agent: { identity: { systemPrompt: () => 'custom', planMode: true }, tools: ['Read', 'Write', 'EnterPlanMode'] }, enabledModules: [] }
    const { cwd, engine } = setup([{ calls: [{ name: 'Write', input: { file_path: 'new.txt', content: 'unsafe' } }] }], source)
    expect(engine.isPlanMode()).toBe(true)
    engine.getConfig().agent?.tools?.push('Bash')
    expect(source.agent?.tools).not.toContain('Bash')
    await engine.runTurn('analyze', [])
    expect(existsSync(join(cwd, 'new.txt'))).toBe(false)
  })

  it('retains the coordinator Agent capability with a main agent identity', async () => {
    const { engine, requests } = setup([], { agent: { identity: { systemPrompt: () => 'coordinator' } } })
    await engine.runTurn('explain', [])
    const defs = requests[0].tools as Array<{ function: { name: string } }>
    expect(defs.some(d => d.function.name === 'Agent')).toBe(true)
  })

  it('serializes plan approval and applies rejection/approval immediately', async () => {
    const approve = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const { engine, cwd } = setup([
      { calls: [{ name: 'ExitPlanMode', input: { plan: 'edit' } }, { name: 'Write', input: { file_path: 'denied.txt', content: 'no' } }] },
      { calls: [{ name: 'ExitPlanMode', input: { plan: 'edit' } }, { name: 'Write', input: { file_path: 'approved.txt', content: 'yes' } }] },
    ], { planMode: true, exitPlanMode: approve })
    await engine.runTurn('implement approved plan', [])
    expect(existsSync(join(cwd, 'denied.txt'))).toBe(false)
    expect(readFileSync(join(cwd, 'approved.txt'), 'utf8')).toBe('yes')
  })

  it('settles throwing siblings and records exactly one result per call', async () => {
    let completed = false
    const { engine } = setup([{ calls: [{ name: 'Broken' }, { name: 'Slow' }] }], { extraTools: [
      tool('Broken', () => Promise.reject(new Error('failure')), true),
      tool('Slow', async () => { await new Promise(resolve => setTimeout(resolve, 15)); completed = true; return { content: 'done', isError: false } }, true),
    ] })
    const { newHistory } = await engine.runTurn('read both', [])
    expect(completed).toBe(true)
    const results = newHistory.filter(m => m.role === 'tool')
    expect(results).toHaveLength(2)
    expect(new Set(results.map(r => r.tool_call_id)).size).toBe(2)
  })

  it('does not allow another engine to clear or borrow file reads', async () => {
    const second = setup([]).engine
    const contexts: ToolContext[] = []
    const { engine, cwd } = setup([{ calls: [{ name: 'Read', input: { file_path: 'a.txt' } }, { name: 'Sibling' }, { name: 'Edit', input: { file_path: 'a.txt', old_string: 'before', new_string: 'after' } }] }], {
      extraTools: [tool('Sibling', async (_input, ctx) => { contexts.push(ctx); await second.runTurn('explain', []); return { content: 'done', isError: false } })],
    })
    writeFileSync(join(cwd, 'a.txt'), 'before')
    await engine.runTurn('edit after read', [])
    expect(readFileSync(join(cwd, 'a.txt'), 'utf8')).toBe('after')
    expect(contexts[0]).toHaveProperty('runId')
  })

  it('keeps continuation output and rejects incomplete or filtered streams', async () => {
    const { engine } = setup([{ text: 'first ', finish: 'length' }, { text: 'second', finish: 'stop' }])
    expect((await engine.runTurn('answer', [])).result.output).toBe('first second')
    for (const finish of [null, 'content_filter']) {
      const other = setup([{ text: 'partial', finish }]).engine
      expect((await other.runTurn('answer', [])).result).toMatchObject({ status: 'failed' })
    }
  })

  it('refreshes the context window when the model changes', async () => {
    const { engine, requests } = setup([], { maxOutputTokens: 100000, agent: { identity: { systemPrompt: () => '' }, tools: [] } })
    await engine.runTurn('one', [])
    engine.setModel('gpt-3.5-turbo')
    await engine.runTurn('two', [])
    expect(Number(requests[1].max_tokens)).toBeLessThan(Number(requests[0].max_tokens))
  })

  it('creates the abort domain before module boot', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const name = `boot-${Date.now()}`
    globalModuleRegistry.register(name, () => ({ name, boot: ctx => new Promise((_resolve, reject) => {
      started()
      const signal = (ctx as unknown as { abortSignal?: AbortSignal }).abortSignal
      if (signal) signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      else setTimeout(() => reject(new Error('missing signal')), 60)
    }) }))
    const { engine } = setup([], { enabledModules: [name] })
    const running = engine.runTurn('boot', [])
    await ready
    engine.abort()
    await expect(running).resolves.toMatchObject({ result: { status: 'cancelled' } })
  })

  it('quarantines an uncooperative tool until it actually settles', async () => {
    let release!: () => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const { engine } = setup([{ calls: [{ name: 'Stubborn' }] }], {
      cancellationGraceMs: 10,
      extraTools: [tool('Stubborn', () => new Promise(resolve => {
        started()
        release = () => resolve({ content: 'late', isError: false })
      }))],
    })
    const running = engine.runTurn('mutate', [])
    await ready
    engine.abort()
    const cancelled = await running
    expect(cancelled.result.status).toBe('cancelled')
    expect(cancelled.newHistory.filter(m => m.role === 'tool')).toHaveLength(1)
    expect((await engine.runTurn('next', [])).result.status).toBe('blocked')
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await engine.runTurn('next', [])).result.status).toBe('completed')
    expect(cancelled.newHistory.filter(m => m.role === 'tool')).toHaveLength(1)
  })

  it('checks module injected content before sending a model request', async () => {
    const name = `oversize-${Date.now()}`
    globalModuleRegistry.register(name, () => ({ name, boot: () => ({}), onIteration: () => Promise.resolve({ injectMessage: 'z'.repeat(100_000) }) }))
    const { engine, requests } = setup([], { enabledModules: [name], maxContextTokens: 8192 })
    expect((await engine.runTurn('small question', [])).result.status).toBe('failed')
    expect(requests).toHaveLength(0)
  })

  it('rejects conflicting registrations before execution', () => {
    const duplicate = tool('Read', () => Promise.resolve({ content: '', isError: false }))
    expect(() => setup([], { extraTools: [duplicate] })).toThrow(/duplicate/i)
    const mismatch = tool('Mismatch', () => Promise.resolve({ content: '', isError: false }))
    mismatch.definition.function.name = 'Other'
    expect(() => setup([], { extraTools: [mismatch] })).toThrow(/name/i)
  })

  it('snip zero preserves the current target and outstanding tool group', async () => {
    const { engine, requests } = setup([{ calls: [{ name: 'Snip', input: { keep_recent: 0 } }] }])
    const history = Array.from({ length: 14 }, (_, index) => ({ role: 'user' as const, content: `old-${index}` }))
    await engine.runTurn('preserve this current goal', history)
    const messages = requests.at(-1)?.messages as Array<{ role: string; content: string; tool_calls?: unknown[]; tool_call_id?: string }>
    expect(messages.some(m => String(m.content).startsWith('old-'))).toBe(false)
    expect(messages.some(m => m.content === 'preserve this current goal')).toBe(true)
    expect(messages.filter(m => m.tool_calls)).toHaveLength(1)
    expect(messages.filter(m => m.tool_call_id)).toHaveLength(1)
  })

  it('queueSnip zero trims historical messages and rejects invalid counts', async () => {
    const { engine, requests } = setup([])
    for (const value of [NaN, Infinity, -1, 1.5]) expect(() => engine.queueSnip(value)).toThrow()
    engine.queueSnip(0)
    await engine.runTurn('active', [{ role: 'user', content: 'old' }, { role: 'assistant', content: 'obsolete' }])
    const messages = requests[0].messages as Array<{ content: string }>
    expect(messages.some(m => m.content === 'old' || m.content === 'obsolete')).toBe(false)
    expect(messages.some(m => m.content === 'active')).toBe(true)
  })

  it('invalidates acceptance when a finalizer changes the artifact', async () => {
    const name = `final-write-${Date.now()}`
    globalModuleRegistry.register(name, () => ({
      name, boot: () => ({}),
      onComplete: ctx => { writeFileSync(join(ctx.cwd, 'late.txt'), 'unverified change') },
    }))
    const { engine } = setup([], { enabledModules: [name] })
    const { result } = await engine.runTurn('explain', [])
    expect(result.status).toBe('blocked')
    expect(result.verification?.status).toBe('failed')
  })

  it('propagates a failed real child verification to the parent outcome', async () => {
    const { engine, cwd } = setup([{ calls: [{ name: 'Agent', input: { description: 'edit', prompt: 'edit source', verify: false } }] }], {
      agentFactory: cfg => ({
        runTurn: () => {
          writeFileSync(join(cfg.cwd, 'source.txt'), 'changed')
          return Promise.resolve({ result: { reason: 'stop_sequence', output: 'done' } })
        }, abort: () => {},
      }),
    })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(9)"' } }))
    const { result, newHistory } = await engine.runTurn('implement', [])
    expect(result.status).toBe('failed')
    expect(result.reason).toBe('error')
    expect(newHistory.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('FAILED'))).toBe(true)
  })

  it('reports timed-out disposal and quarantines unfinished cleanup', async () => {
    let release!: () => void
    const name = `dispose-${Date.now()}`
    globalModuleRegistry.register(name, () => ({ name, boot: () => ({}), dispose: () => new Promise<void>(resolve => { release = resolve }) }))
    const { engine, cwd } = setup([], { enabledModules: [name], cancellationGraceMs: 10 })
    await expect(engine.dispose()).rejects.toThrow(/cleanup|dispose/i)
    const other = setup([], { cwd }).engine
    expect((await other.runTurn('next', [])).result.status).toBe('blocked')
    release()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await other.runTurn('next', [])).result.status).toBe('completed')
    engines.splice(engines.indexOf(engine), 1)
  })

  it('does not erase a failed sibling Agent when another child succeeds', async () => {
    let child = 0
    const { engine } = setup([{ calls: [{ name: 'Agent', input: { description: 'first', prompt: 'first' } }, { name: 'Agent', input: { description: 'second', prompt: 'second' } }] }], {
      agentFactory: () => ({ runTurn: () => Promise.resolve({ result: { reason: child++ === 0 ? 'error' : 'stop_sequence', output: 'child result' } }), abort: () => {} }),
    })
    expect((await engine.runTurn('two independent tasks', [])).result.status).toBe('failed')
  })

  it('settles tool calls from an incomplete stream without executing them', async () => {
    const execute = vi.fn(() => Promise.resolve({ content: 'done', isError: false }))
    const { engine } = setup([{ finish: 'length', calls: [{ name: 'Touch' }] }], { extraTools: [tool('Touch', execute)] })
    const { result, newHistory } = await engine.runTurn('do it', [])
    expect(result.status).toBe('failed')
    expect(execute).not.toHaveBeenCalled()
    expect(newHistory.filter(m => m.role === 'tool')).toHaveLength(1)
  })
})

describe('policy and shell classification', () => {
  it('gives explicit deny precedence over earlier allow', () => {
    const manager = new PermissionManager()
    manager.setMode('bypassPermissions')
    manager.addRule({ toolName: 'Bash', ruleContent: '*', behavior: 'allow', source: 'user' })
    manager.addRule({ toolName: 'Bash', ruleContent: 'git push*', behavior: 'deny', source: 'user' })
    expect(manager.check('Bash', { command: 'git push origin main' }, false)).toBe('deny')
  })

  it.each(['echo text > file', 'echo $(touch file)', 'echo `touch file`', 'ls\nrm file', 'git branch -D feature', 'git remote add origin x', 'find . -delete'])('treats shell effects conservatively: %s', command => {
    expect(new BashTool().isConcurrencySafe({ command })).toBe(false)
  })
})
