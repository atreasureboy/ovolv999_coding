import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { configurationCommands } from '../../../src/commands/configurationCommands.js'
import type { SlashCommandContext } from '../../../src/commands/index.js'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { getEffortPrompt, setEffort } from '../../../src/core/effort.js'
import type { Renderer } from '../../../src/ui/renderer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.engine.dispose()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
  setEffort('medium')
})

function setup() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-effort-request-'))
  const requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = []
  const client = {
    chat: { completions: { create: (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
      requests.push(params)
      return Promise.resolve((async function* () {
        await Promise.resolve()
        yield { choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }] }
      })())
    } } },
  } as unknown as OpenAI
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({
    cwd, model: 'offline-model', apiKey: 'offline', permissionMode: 'deny',
    maxIterations: 1, enabledModules: [],
    agent: { identity: { systemPrompt: () => 'Project instructions.' }, tools: [] },
  }, renderer, client)
  fixtures.push({ engine, cwd })
  return {
    engine, requests,
    context: { engine, renderer, cwd, history: [], setHistory: vi.fn(), runPrompt: vi.fn() } as SlashCommandContext,
  }
}

async function effort(args: string, context: SlashCommandContext) {
  const command = configurationCommands.find(command => command.name === 'effort')!
  return command.handler(args, context)
}

it('applies /effort to the next actual engine request while preserving project instructions', async () => {
  const test = setup()
  await effort('high', test.context)
  await test.engine.runTurn('answer', [])
  expect(test.engine.getConfig().effort).toBe('high')
  expect(test.requests[0].messages[0].content).toContain('Project instructions.')
  expect(test.requests[0].messages[0].content).toContain(getEffortPrompt('high'))
  expect(test.requests[0].reasoning_effort).toBeUndefined()
})

it('keeps effort changes local to each engine and independent of legacy utility state', async () => {
  const first = setup()
  const second = setup()
  await effort('maximum', first.context)
  setEffort('minimal')
  await Promise.all([first.engine.runTurn('one', []), second.engine.runTurn('two', [])])
  expect(first.engine.getConfig().effort).toBe('maximum')
  expect(second.engine.getConfig().effort).toBe('medium')
  expect(first.requests[0].messages[0].content).toContain(getEffortPrompt('maximum'))
  expect(second.requests[0].messages[0].content).toContain(getEffortPrompt('medium'))
  expect(second.requests[0].messages[0].content).not.toContain('multiple approaches')
})

it('cycles engine effort and reports its own active setting', async () => {
  const test = setup()
  await effort('maximum', test.context)
  const cycled = await effort('cycle', test.context)
  expect(test.engine.getConfig().effort).toBe('minimal')
  expect(cycled).toEqual(expect.objectContaining({ value: expect.stringContaining('minimal') }))
  expect(await effort('', test.context)).toEqual(expect.objectContaining({ value: expect.stringContaining('minimal') }))
  const unknown = await effort('invalid', test.context)
  expect(unknown).toEqual(expect.objectContaining({ value: expect.stringContaining('Unknown level') }))
  expect(test.engine.getConfig().effort).toBe('minimal')
})

it('describes behavioral guidance without claiming an unenforced thinking-token budget', () => {
  expect(getEffortPrompt('high')).not.toContain('thinking tokens')
})
