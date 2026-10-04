import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { EngineConfig, HookDecision, IHookRunner } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.engine.dispose()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})

function setup(hookRunner: IHookRunner, overrides: Partial<EngineConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-hook-decision-'))
  let requests = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    if (++requests === 1) {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'write', function: {
        name: 'Write', arguments: JSON.stringify({ file_path: 'original.txt', content: 'changed' }),
      } }] }, finish_reason: 'tool_calls' }] }
    } else yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
  })()) } } } as unknown as OpenAI
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({
    cwd, model: 'offline-model', apiKey: 'offline', permissionMode: 'auto',
    maxIterations: 2, enabledModules: [], hookRunner, ...overrides,
  }, renderer, client)
  fixtures.push({ engine, cwd })
  return { engine, cwd }
}

function hooks(pre: HookDecision[] | Promise<HookDecision[]>) {
  return {
    runPreToolCall: vi.fn(() => Promise.resolve(pre).then(decisions => decisions.map(decision => ({
      hook: 'PreToolUse', command: 'offline-test', ok: true, status: 0, signal: null, durationMs: 0, decision,
    })))),
    runPostToolCall: vi.fn(() => []),
    runUserPromptSubmit: vi.fn(() => []),
  }
}

it('awaits a policy denial and never executes Write', async () => {
  const runner = hooks(Promise.resolve([{ action: 'deny', reason: 'protected file' }]))
  const test = setup(runner)
  const { newHistory } = await test.engine.runTurn('write', [])
  expect(existsSync(join(test.cwd, 'original.txt'))).toBe(false)
  expect(newHistory.find(message => message.role === 'tool')?.content).toContain('protected file')
  expect(runner.runPreToolCall).toHaveBeenCalledOnce()
  expect(runner.runPostToolCall).toHaveBeenCalledOnce()
})

it('checks permissions against updated hook input before any side effect', async () => {
  const runner = hooks([{ action: 'continue', updatedInput: { file_path: 'restricted.txt', content: 'changed' } }])
  const test = setup(runner, { permissionMode: 'ask' })
  const manager = test.engine.getPermissionManager()
  manager.addRule({ toolName: 'Write', ruleContent: 'original.txt', behavior: 'allow', source: 'user' })
  manager.addRule({ toolName: 'Write', ruleContent: 'restricted.txt', behavior: 'deny', source: 'user' })
  const { newHistory } = await test.engine.runTurn('write', [])
  expect(existsSync(join(test.cwd, 'original.txt'))).toBe(false)
  expect(existsSync(join(test.cwd, 'restricted.txt'))).toBe(false)
  expect(newHistory.find(message => message.role === 'tool')?.content).toContain('Permission denied')
})

it('requires an approval channel for an explicit policy ask even in automatic mode', async () => {
  const runner = hooks([{ action: 'ask', reason: 'confirm release file' }])
  const test = setup(runner)
  const { result } = await test.engine.runTurn('write', [])
  expect(existsSync(join(test.cwd, 'original.txt'))).toBe(false)
  expect(result.status).toBe('needs_input')
})
