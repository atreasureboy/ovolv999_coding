import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { EngineConfig, IHookRunner } from '../../../src/core/types.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'

const fixtures: Array<{ engine: ExecutionEngine; base: string }> = []

afterEach(async () => {
  for (const { engine, base } of fixtures.splice(0)) {
    await engine.dispose()
    rmSync(base, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function setup(reply: (request: OpenAI.Chat.ChatCompletionCreateParamsStreaming, index: number, cwd: string) => Record<string, unknown>, overrides: Partial<EngineConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-path-instructions-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  vi.stubEnv('OVOGO_STATE_DIR', join(base, 'runtime'))
  const requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = []
  const client = { chat: { completions: { create: (request: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
    requests.push(structuredClone(request))
    const value = reply(request, requests.length, cwd)
    return Promise.resolve((async function* () { await Promise.resolve(); yield value })())
  } } } } as unknown as OpenAI
  const engine = new ExecutionEngine({ cwd, apiKey: 'offline', model: 'offline', maxIterations: 4, permissionMode: 'auto', enabledModules: [], agent: { identity: { systemPrompt: () => 'static identity' }, tools: ['Read', 'Write'] }, ...overrides }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver, client)
  fixtures.push({ engine, base })
  return { cwd, engine, requests }
}

const answer = () => ({ choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }] })
const write = (id: string, file: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'Write', arguments: JSON.stringify({ file_path: file, content: 'created' }) } }] }, finish_reason: 'tool_calls' }] })
const read = (id: string, file: string) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name: 'Read', arguments: JSON.stringify({ file_path: file }) } }] }, finish_reason: 'tool_calls' }] })
const system = (request: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
  const content = request.messages[0].content
  return typeof content === 'string' ? content : JSON.stringify(content)
}

it('refreshes changed and deleted startup instructions for every turn', async () => {
  const { cwd, engine, requests } = setup(answer)
  const rules = join(cwd, 'AGENTS.md')
  writeFileSync(rules, 'ROOT_RULE_VERSION_ONE')
  await engine.runTurn('respond', [])
  expect(system(requests[0])).toContain('ROOT_RULE_VERSION_ONE')
  writeFileSync(rules, 'ROOT_RULE_VERSION_TWO')
  await engine.runTurn('respond again', [])
  expect(system(requests[1])).toContain('ROOT_RULE_VERSION_TWO')
  expect(system(requests[1])).not.toContain('ROOT_RULE_VERSION_ONE')
  rmSync(rules)
  await engine.runTurn('respond again', [])
  expect(system(requests[2])).not.toContain('ROOT_RULE_VERSION_TWO')
})

it('defers an actual nested write until the model has received its applicable instructions', async () => {
  let existedBeforeRetry = true
  const { cwd, engine, requests } = setup((_request, index, workspace) => {
    if (index === 2) existedBeforeRetry = existsSync(join(workspace, 'left', 'result.txt'))
    return index <= 2 ? write(`nested-${index}`, 'left/result.txt') : answer()
  })
  for (const name of ['left', 'right']) mkdirSync(join(cwd, name))
  writeFileSync(join(cwd, 'left', 'AGENTS.md'), 'LEFT_ONLY_RULE')
  writeFileSync(join(cwd, 'right', 'AGENTS.md'), 'RIGHT_ONLY_RULE')
  await engine.runTurn('write the left result', [])
  expect(existedBeforeRetry).toBe(false)
  expect(system(requests[0])).not.toContain('LEFT_ONLY_RULE')
  expect(system(requests[1])).toContain('LEFT_ONLY_RULE')
  expect(system(requests[1])).not.toContain('RIGHT_ONLY_RULE')
  expect(readFileSync(join(cwd, 'left', 'result.txt'), 'utf8')).toBe('created')
})

it('checks the final hook-rewritten target before permitting a mutation', async () => {
  const hookRunner: IHookRunner = {
    canModifyToolInput: () => true,
    runPreToolCall: () => [{ hook: 'PreToolUse', command: 'fixture', ok: true, status: 0, signal: null, durationMs: 0, decision: { action: 'continue', updatedInput: { file_path: 'restricted/result.txt', content: 'created' } } }],
    runPostToolCall: () => [],
    runUserPromptSubmit: () => [],
  }
  const { cwd, engine, requests } = setup((_request, index) => index === 1 ? write('rewritten', 'plain.txt') : answer(), { hookRunner })
  mkdirSync(join(cwd, 'restricted'))
  writeFileSync(join(cwd, 'restricted', 'AGENTS.md'), 'REWRITTEN_TARGET_RULE')
  await engine.runTurn('write a result', [])
  expect(existsSync(join(cwd, 'restricted', 'result.txt'))).toBe(false)
  expect(system(requests[1])).toContain('REWRITTEN_TARGET_RULE')
})

it('applies physical directory instructions before writing through an internal alias', async () => {
  let existedBeforeRetry = true
  const { cwd, engine, requests } = setup((_request, index, workspace) => {
    if (index === 2) existedBeforeRetry = existsSync(join(workspace, 'actual', 'result.txt'))
    return index <= 2 ? write(`alias-${index}`, 'alias/result.txt') : answer()
  })
  mkdirSync(join(cwd, 'actual'))
  symlinkSync(join(cwd, 'actual'), join(cwd, 'alias'), 'junction')
  writeFileSync(join(cwd, 'actual', 'AGENTS.md'), 'PHYSICAL_TARGET_RULE')
  await engine.runTurn('write through the alias', [])
  expect(existedBeforeRetry).toBe(false)
  expect(system(requests[1])).toContain('PHYSICAL_TARGET_RULE')
  expect(readFileSync(join(cwd, 'actual', 'result.txt'), 'utf8')).toBe('created')
})

it('rechecks instructions changed while approval was pending before an actual write', async () => {
  const { cwd, engine, requests } = setup((_request, index) => index === 1 ? write('approval-race', 'result.txt') : answer(), {
    permissionMode: 'ask',
    requestPermission: () => {
      writeFileSync(join(cwd, 'AGENTS.md'), 'RULE_CHANGED_DURING_APPROVAL')
      return Promise.resolve({ approved: true })
    },
  })
  await engine.runTurn('write with approval', [])
  expect(existsSync(join(cwd, 'result.txt'))).toBe(false)
  expect(system(requests[1])).toContain('RULE_CHANGED_DURING_APPROVAL')
})

it('keeps instruction tracking bounded without refusing a long sequence of file targets', async () => {
  const { cwd } = setup(answer)
  const { PathInstructionContext } = await import('../../../src/core/engine/instructions.js')
  const context = new PathInstructionContext(cwd)
  await context.refresh()
  for (let index = 0; index < 80; index++) {
    expect(await context.beforeTool('Read', { file_path: `source-${index}.txt` })).toBeUndefined()
  }
  await expect(context.refresh()).resolves.toBe('')
})

it.each(['outside-root', 'malformed-rule'])('allows a corrected target after a %s resolution failure', async kind => {
  const { cwd, engine, requests } = setup((_request, index) => index === 1
    ? read('invalid-target', kind === 'outside-root' ? '../missing.txt' : 'broken/input.txt')
    : index === 2 ? read('corrected-target', 'good.txt') : answer())
  writeFileSync(join(cwd, 'good.txt'), 'CORRECTED_TARGET_CONTENT')
  if (kind === 'malformed-rule') {
    mkdirSync(join(cwd, 'broken'))
    writeFileSync(join(cwd, 'broken', 'AGENTS.md'), Buffer.from([0xc3, 0x28]))
    writeFileSync(join(cwd, 'broken', 'input.txt'), 'unread')
  }
  const result = await engine.runTurn('read the file and correct an invalid target', [])
  expect(requests).toHaveLength(3)
  expect(result.newHistory.filter(message => message.role === 'tool').some(message => JSON.stringify(message.content).includes('CORRECTED_TARGET_CONTENT'))).toBe(true)
})

it('preserves permitted top-level external reads with separately scoped target instructions', async () => {
  const { cwd, engine, requests } = setup((_request, index) => index <= 2 ? read(`external-${index}`, '../external/input.txt') : answer())
  const external = join(cwd, '..', 'external')
  mkdirSync(external)
  writeFileSync(join(cwd, 'AGENTS.md'), 'PROJECT_SCOPE_ONLY')
  writeFileSync(join(external, 'AGENTS.md'), 'EXTERNAL_SCOPE_ONLY')
  writeFileSync(join(external, 'input.txt'), 'PERMITTED_EXTERNAL_CONTENT')
  mkdirSync(join(cwd, 'sibling'))
  writeFileSync(join(cwd, 'sibling', 'AGENTS.md'), 'UNRELATED_SIBLING_RULE')
  const result = await engine.runTurn('read the explicit external file', [])
  expect(requests).toHaveLength(3)
  expect(system(requests[0])).not.toContain('EXTERNAL_SCOPE_ONLY')
  expect(system(requests[1])).toContain('EXTERNAL_SCOPE_ONLY')
  expect(system(requests[1])).toContain(JSON.stringify(external))
  expect(system(requests[1])).not.toContain('UNRELATED_SIBLING_RULE')
  expect(result.newHistory.filter(message => message.role === 'tool').some(message => JSON.stringify(message.content).includes('PERMITTED_EXTERNAL_CONTENT'))).toBe(true)
  expect(result.result.status).toBe('completed')
})

it('keeps an external target outside a bound child workspace without poisoning subsequent instructions', async () => {
  const { cwd } = setup(answer)
  const { PathInstructionContext } = await import('../../../src/core/engine/instructions.js')
  const context = new PathInstructionContext(cwd, true)
  const initial = await context.refresh()
  const blocked = await context.beforeTool('Read', { file_path: '../external.txt' })
  expect(blocked?.isError).toBe(true)
  expect(blocked?.status).toBe('blocked')
  await expect(context.refresh()).resolves.toBe(initial)
})

it('isolates external ancestor rules from the project and notices their deletion', async () => {
  const { cwd } = setup(answer)
  const { PathInstructionContext } = await import('../../../src/core/engine/instructions.js')
  const context = new PathInstructionContext(cwd)
  const externalRules = join(cwd, '..', 'AGENTS.md')
  writeFileSync(join(cwd, 'AGENTS.md'), 'PROJECT_RULE')
  writeFileSync(externalRules, 'EXTERNAL_ANCESTOR_RULE')
  writeFileSync(join(cwd, '..', 'input.txt'), 'external data')
  expect(await context.refresh()).not.toContain('EXTERNAL_ANCESTOR_RULE')
  expect((await context.beforeTool('Read', { file_path: '../input.txt' }))?.status).toBe('blocked')
  expect(await context.refresh()).toContain('EXTERNAL_ANCESTOR_RULE')
  expect(await context.beforeTool('Read', { file_path: 'good.txt' })).toBeUndefined()
  rmSync(externalRules)
  expect((await context.beforeTool('Read', { file_path: '../input.txt' }))?.status).toBe('blocked')
  expect(await context.refresh()).not.toContain('EXTERNAL_ANCESTOR_RULE')
  expect(await context.beforeTool('Read', { file_path: '../input.txt' })).toBeUndefined()
})

it('allows a corrected target after the combined instruction capacity is exceeded', async () => {
  const { cwd, engine, requests } = setup((_request, index) => index <= 2
    ? read(`capacity-${index}`, `scope-${index}/input.txt`)
    : index === 3 ? read('corrected-capacity', 'good.txt') : answer(), { maxIterations: 6, maxContextTokens: 500000 })
  for (let index = 1; index <= 2; index++) {
    const directory = join(cwd, `scope-${index}`)
    mkdirSync(directory)
    for (const source of ['CLAUDE.md', 'AGENTS.md', 'OVOGO.md', '.claude/CLAUDE.md', '.ovolv999/instructions.md', '.ovogo/OVOGO.md']) {
      const path = join(directory, source)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${index}${'x'.repeat(23998)}`)
    }
    writeFileSync(join(directory, 'input.txt'), `input-${index}`)
  }
  writeFileSync(join(cwd, 'good.txt'), 'CORRECTED_AFTER_CAPACITY')
  const result = await engine.runTurn('read the files and correct a target after a capacity diagnostic', [])
  expect(requests).toHaveLength(4)
  expect(result.newHistory.filter(message => message.role === 'tool').some(message => JSON.stringify(message.content).includes('CORRECTED_AFTER_CAPACITY'))).toBe(true)
})
