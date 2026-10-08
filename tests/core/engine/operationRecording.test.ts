import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { RunStore } from '../../../src/core/runStore.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'
import type { EngineConfig, Tool } from '../../../src/core/types.js'

const fixtures: Array<{ engine: ExecutionEngine; base: string }> = []
afterEach(async () => {
  for (const { engine, base } of fixtures.splice(0)) { await engine.dispose(); rmSync(base, { recursive: true, force: true }) }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function setup(tool = 'Write', input: Record<string, unknown> = { file_path: 'result.txt', content: 'fixture-secret-content' }, overrides: Partial<EngineConfig> = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-record-operation-'))
  const cwd = join(base, 'workspace'), state = join(base, 'runtime')
  mkdirSync(cwd)
  vi.stubEnv('OVOGO_STATE_DIR', state)
  let requests = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    yield ++requests === 1 ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'mutation', function: { name: tool, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] }
      : { choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }] }
  })()) } } } as unknown as OpenAI
  const engine = new ExecutionEngine({ cwd, model: 'offline', apiKey: 'offline', maxIterations: 3, permissionMode: 'auto', enabledModules: [], agent: { identity: { systemPrompt: () => 'fixture' }, tools: [tool] }, ...overrides }, new Proxy({}, { get: () => vi.fn() }) as EngineObserver, client)
  fixtures.push({ engine, base })
  return { engine, cwd, state }
}

it('records final input identity and builtin file evidence without plaintext content', async () => {
  const { engine, cwd, state } = setup()
  const { result } = await engine.runTurn('write the fixture', [])
  const path = join(state, 'runs', result.runId + '.json')
  const raw = readFileSync(path, 'utf8')
  const operation = Object.values(RunStore.inspect(path).operations)[0]
  expect(operation).toMatchObject({ name: 'Write', workspace: cwd, affectedPaths: [join(cwd, 'result.txt')], inputDigest: expect.stringMatching(/^[a-f0-9]{64}$/), fileEvidence: { kind: 'builtin-file', completion: 'write-only', beforeHash: null }, receipt: { status: 'completed', effects: 'observed_applied' } })
  expect(raw).not.toContain('fixture-secret-content')
})

it('retains unknown effects for a failed external mutation and never grants builtin evidence callbacks', async () => {
  let calls = 0
  const extra: Tool = { name: 'ExternalMutation', metadata: { mutatesState: true }, definition: { type: 'function', function: { name: 'ExternalMutation', description: 'offline external fixture', parameters: { type: 'object', properties: {} } } }, execute: (_input, context) => {
    calls++
    expect(context.recordFileEvidence).toBeUndefined()
    expect(context.recordFileObservation).toBeUndefined()
    writeFileSync(join(context.cwd, 'external.txt'), 'accepted before disconnect')
    return Promise.resolve({ content: 'connection lost after acceptance', isError: true })
  } }
  const { engine, cwd, state } = setup(extra.name, {}, { extraTools: [extra] })
  const { result } = await engine.runTurn('perform the fixture once', [])
  const record = RunStore.inspect(join(state, 'runs', result.runId + '.json'))
  expect(calls).toBe(1)
  expect(readFileSync(join(cwd, 'external.txt'), 'utf8')).toBe('accepted before disconnect')
  expect(record.status).toBe('needs_recovery')
  expect(Object.values(record.operations)[0]).toMatchObject({ receipt: { status: 'failed', effects: 'unknown' } })
})

it('refuses builtin mutation when durable file evidence cannot be saved', async () => {
  vi.spyOn(RunStore.prototype, 'recordFileEvidence').mockImplementation(() => { throw new Error('fixture evidence persistence refused') })
  const { engine, cwd, state } = setup()
  const { result } = await engine.runTurn('write the fixture', [])
  expect(existsSync(join(cwd, 'result.txt'))).toBe(false)
  const operation = Object.values(RunStore.inspect(join(state, 'runs', result.runId + '.json')).operations)[0]
  expect(operation.receipt).toMatchObject({ status: 'failed', effects: 'not_started' })
})

it('preserves an applied mutation as unknown when its durable observation fails', async () => {
  vi.spyOn(RunStore.prototype, 'recordFileObservation').mockImplementation(() => { throw new Error('fixture observation persistence refused') })
  const { engine, cwd, state } = setup()
  const { result } = await engine.runTurn('write the fixture', [])
  expect(readFileSync(join(cwd, 'result.txt'), 'utf8')).toBe('fixture-secret-content')
  const record = RunStore.inspect(join(state, 'runs', result.runId + '.json'))
  expect(record.status).toBe('needs_recovery')
  expect(Object.values(record.operations)[0]).toMatchObject({ fileEvidence: { kind: 'builtin-file' }, receipt: { status: 'failed', effects: 'unknown' } })
})

it('binds the actual background task to its Engine operation before returning the task handle', async () => {
  const { engine, state } = setup('Bash', { command: `"${process.execPath}" -e "setTimeout(() => {}, 20)"`, run_in_background: true })
  const { result } = await engine.runTurn('run the background fixture', [])
  const record = RunStore.inspect(join(state, 'runs', result.runId + '.json'))
  expect(Object.values(record.operations)[0].resourceIds).toEqual([expect.stringMatching(/^background-task:task_/)])
})
