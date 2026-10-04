import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { getExecutionHealth } from '../../../src/core/executionBackend.js'
import { HookService } from '../../../src/core/hookService.js'
import { RunStore } from '../../../src/core/runStore.js'
import { runtimeStateRoot } from '../../../src/core/runtimeState.js'
import type { EngineConfig, HookResult, IHookRunner } from '../../../src/core/types.js'
import { BashTool } from '../../../src/tools/bash.js'
import type { Renderer } from '../../../src/ui/renderer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.engine.abort()
    await fixture.engine.dispose()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function setup(hooks: (cwd: string) => IHookRunner, commands: string[] = [], overrides: Partial<EngineConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-hook-lifecycle-'))
  let requests = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    if (++requests === 1 && commands.length) {
      yield { choices: [{ delta: { tool_calls: commands.map((command, index) => ({
        index, id: `hook-call-${index}`, function: { name: 'Bash', arguments: JSON.stringify({ command }) },
      })) }, finish_reason: 'tool_calls' }] }
    } else {
      yield { choices: [{ delta: { content: 'offline answer' }, finish_reason: 'stop' }] }
    }
  })()) } } } as unknown as OpenAI
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({
    cwd, model: 'offline-model', apiKey: 'offline', permissionMode: 'auto', maxIterations: 2,
    enabledModules: [], hookRunner: hooks(cwd), maxToolConcurrency: 4, cancellationGraceMs: 3000,
    ...overrides,
  }, renderer, client)
  fixtures.push({ engine, cwd })
  return { engine, cwd }
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Hook lifecycle operation exceeded its test bound')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('engine hook lifecycle regressions', () => {
  it('serializes safe Bash calls rewritten into mutations and checks native permissions for the effective input', async () => {
    const rewritten = ['printf first > first.txt', 'printf second > second.txt']
    let rewriteIndex = 0
    const runner: IHookRunner = {
      canModifyToolInput: () => true,
      runPreToolCall: () => Promise.resolve([{
        hook: 'PreToolUse', command: 'offline-rewrite', ok: true, status: 0, signal: null, durationMs: 0,
        decision: { action: 'continue', updatedInput: { command: rewritten[rewriteIndex++] } },
      }] satisfies HookResult[]),
      runPostToolCall: () => [],
      runUserPromptSubmit: () => [],
    }
    let active = 0
    let maximumActive = 0
    const executed: string[] = []
    vi.spyOn(BashTool.prototype, 'execute').mockImplementation(async (input, context) => {
      expect(context.permissionApproved).toBe(true)
      executed.push(String(input.command))
      active++
      maximumActive = Math.max(maximumActive, active)
      try {
        await new Promise<void>(resolve => setTimeout(resolve, 40))
        return { content: 'Bash transport fixture completed', isError: false }
      } finally {
        active--
      }
    })
    const approvals: string[] = []
    const { engine } = setup(() => runner, ['pwd', 'pwd'], {
      requestPermission: (tool, input) => {
        expect(tool).toBe('Bash')
        approvals.push(String(input.command))
        return Promise.resolve({ approved: true })
      },
    })
    const manager = engine.getPermissionManager()
    manager.addRule({ toolName: 'Bash', ruleContent: 'printf first > first.txt', behavior: 'ask', source: 'user' })
    manager.addRule({ toolName: 'Bash', ruleContent: 'printf second > second.txt', behavior: 'ask', source: 'user' })
    const permissionChecks = vi.spyOn(manager, 'check')
    const turn = await engine.runTurn('execute both original safe calls', [])
    expect(maximumActive).toBe(1)
    expect(active).toBe(0)
    expect(executed).toEqual(['printf first > first.txt', 'printf second > second.txt'])
    expect(approvals).toEqual(['printf first > first.txt', 'printf second > second.txt'])
    expect(permissionChecks.mock.calls.map(call => call[1].command)).toEqual(['printf first > first.txt', 'printf second > second.txt'])
    const toolMessages = turn.newHistory.filter(message => message.role === 'tool')
    expect(toolMessages.map(message => message.tool_call_id)).toEqual(['hook-call-0', 'hook-call-1'])
    expect(toolMessages.map(message => message.content)).toEqual(['Bash transport fixture completed', 'Bash transport fixture completed'])
  })

  it('cancels a real OnComplete hook and closes its native process before accepting the run', async () => {
    expect(getExecutionHealth().activeProcesses).toBe(0)
    const { engine } = setup(cwd => new HookService({ OnComplete: [{
      command: [process.execPath, resolve('scripts/fixtures/hook-runtime.mjs'), 'wait'],
      kind: 'notification', timeout: 20000,
    }] }, cwd, { legacyHooks: () => ({}) }))
    const pending = engine.runTurn('answer without tool calls', [])
    await vi.waitFor(() => expect(getExecutionHealth().activeProcesses).toBeGreaterThan(0), { timeout: 3000, interval: 10 })
    engine.abort()
    const { result } = await within(pending, 5000)
    expect(result.status).toBe('cancelled')
    expect(result.reason).toBe('error')
    await vi.waitFor(() => expect(getExecutionHealth().activeProcesses).toBe(0), { timeout: 5000, interval: 10 })
    if (!result.runId) throw new Error('Cancelled hook run did not persist an identity')
    expect(RunStore.inspect(join(runtimeStateRoot(), 'runs', result.runId + '.json')).status).toBe('cancelled')
  }, 15000)

  it('preserves each paired tool result when a legacy asynchronous post notification rejects', async () => {
    const runner: IHookRunner = {
      canModifyToolInput: () => false,
      runPreToolCall: () => [],
      runPostToolCall: () => Promise.reject(new Error('legacy notification failed')),
      runUserPromptSubmit: () => [],
    }
    vi.spyOn(BashTool.prototype, 'execute').mockImplementation(() => Promise.resolve({ content: 'paired result', isError: false }))
    const { engine } = setup(() => runner, ['pwd', 'pwd'])
    const turn = await engine.runTurn('keep tool history intact', [])
    const messages = turn.newHistory.filter(message => message.role === 'tool')
    expect(messages.map(message => message.tool_call_id)).toEqual(['hook-call-0', 'hook-call-1'])
    expect(messages.map(message => message.content)).toEqual(['paired result', 'paired result'])
  })
})
