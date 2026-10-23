import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runLoop } from '../../src/core/loopEngine.js'
import { readSessionSnapshot } from '../../src/core/sessionManager.js'
import { loopFixture, reply } from '../fixtures/loopClient.js'
import type { LoopState } from '../../src/core/autonomy/types.js'
import { LoopAttemptStore } from '../../src/core/autonomy/attemptStore.js'
import { ApprovalBroker } from '../../src/core/approvalBroker.js'
import { setBudget } from '../../src/core/budget.js'
import * as verification from '../../src/core/verification.js'
import type { ServerResponse } from 'node:http'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import type { Tool } from '../../src/core/types.js'
import { FrozenLoop } from '../../src/core/autonomy/loopController.js'
import { AgentTool } from '../../src/tools/agent.js'
import { ExecutionEngine, type EngineObserver } from '../../src/core/engine.js'
import { getWorktreeManager } from '../../src/tools/worktree.js'

const fixtures: Awaited<ReturnType<typeof loopFixture>>[] = []
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); vi.restoreAllMocks(); vi.unstubAllEnvs() })
async function setup(options: Parameters<typeof loopFixture>[0] = {}) { const fixture = await loopFixture(options); fixtures.push(fixture); return fixture }
const state = (sessionDir: string): LoopState => JSON.parse(readFileSync(join(sessionDir, 'loop-controller', 'state.json'), 'utf8')) as LoopState

it('publishes guarded receipts through an existing junction workspace alias', async () => {
  const f = await setup()
  const alias = join(f.base, 'workspace-alias')
  symlinkSync(f.cwd, alias, 'junction')
  const result = await runLoop(f.client, f.renderer, { ...f.config, cwd: alias, loopDir: join(alias, '.loop') })
  expect(result.status, JSON.stringify(result)).toBe('completed')
  expect(result.iterations).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(state(f.sessionDir).current?.checkpoint?.decision).toMatchObject({ action: 'stop', status: 'completed' })
  expect(JSON.parse(readFileSync(join(f.loopDir, 'DONE.flag'), 'utf8')).taskId).toBe(result.runId)
  expect(JSON.parse(readFileSync(join(f.loopDir, 'OUTCOME.json'), 'utf8')).status).toBe('completed')
})

it.each([
  ['DONE.flag', 'completed', 4],
  ['OUTCOME.json', 'completed', 4],
  ['OUTCOME.json', 'limit', 1],
  ['OUTCOME.json', 'failed', 4],
  ['OUTCOME.json', 'continue', 4],
] as const)('preserves outside hardlink bytes at %s on the %s publication path', async (leaf, path, maxIters) => {
  const f = await setup({ check: path === 'completed' || path === 'failed' ? 'process.exit(0)' : "console.error('receipt fixture failure'); process.exit(1)",
    ...(path === 'failed' ? { respond: (_index: number, response: ServerResponse) => { response.writeHead(400, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'receipt fixture provider failure', type: 'invalid_request_error' } })) } } : {}),
  })
  const target = join(f.base, 'outside-receipt.txt')
  const sentinel = Buffer.from('unrelated outside workspace bytes\u0000\u00ff')
  writeFileSync(target, sentinel)
  linkSync(target, join(f.loopDir, leaf))
  expect(lstatSync(target).nlink).toBe(2)
  const result = await runLoop(f.client, f.renderer, { ...f.config, maxIters })
  expect(readFileSync(target)).toEqual(sentinel)
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('recovery_required')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
  expect(state(f.sessionDir).current?.checkpoint).toBeUndefined()
  if (path === 'failed') expect(state(f.sessionDir).current?.terminal?.status).toBe('failed')
  expect(f.requests).toHaveLength(1)
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, maxIters, resume: true })
  expect(resumed.outcomeReason?.code).toBe('recovery_required')
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(readFileSync(target)).toEqual(sentinel)
})

it.for(['DONE.flag', 'OUTCOME.json'] as const)('preserves outside symlink bytes at %s when file symlinks are permitted', async (leaf, context) => {
  const f = await setup()
  const target = join(f.base, 'outside-receipt.txt')
  writeFileSync(target, 'unrelated outside workspace bytes')
  try { symlinkSync(target, join(f.loopDir, leaf), 'file') } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      context.skip(`File symlink unavailable: ${(error as NodeJS.ErrnoException).code}`)
      return
    }
    throw error
  }
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(readFileSync(target, 'utf8')).toBe('unrelated outside workspace bytes')
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('recovery_required')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
})

it('feeds independent failure receipts to the next real request while retaining canonical history', async () => {
  const f = await setup({ history: Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `old ${index}` })),
    check: "const fs = require('fs'); const n = fs.existsSync('../checks.txt') ? Number(fs.readFileSync('../checks.txt','utf8')) : 0; fs.writeFileSync('../checks.txt',String(n+1)); if (!fs.existsSync('fixed.txt')) { console.error('EXPECTED_FIXTURE_FAILURE'); process.exit(1) }",
    respond: (index, response, cwd) => { if (index === 2) writeFileSync(join(cwd, 'fixed.txt'), 'fixed'); reply(response) },
  })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status, JSON.stringify(result)).toBe('completed')
  expect(result.iterations).toBe(2)
  const secondModelRequest = JSON.stringify(f.requests[1])
  expect(secondModelRequest).toContain('node check.cjs')
  expect(secondModelRequest).toContain('exitCode: 1')
  expect(secondModelRequest).toContain('EXPECTED_FIXTURE_FAILURE')
  expect(readSessionSnapshot(f.sessionDir).messages.length).toBeGreaterThan(f.client.getModelWindow().length)
  expect(state(f.sessionDir).current?.checkpoint?.verificationSource).toBe('loop')
  expect(readFileSync(join(f.base, 'checks.txt'), 'utf8')).toBe('3')
})

it.each(['prepared', 'dispatched', 'settled'] as const)('blocks ambiguous %s resume without submission or refund', async phase => {
  const f = await setup()
  await runLoop(f.client, f.renderer, f.config)
  await f.client.dispose()
  const saved = state(f.sessionDir)
  saved.current!.phase = phase
  delete saved.current!.checkpoint
  if (phase !== 'settled') delete saved.current!.terminal
  if (phase === 'prepared') delete saved.current!.turn
  writeFileSync(join(f.sessionDir, 'loop-controller', 'state.json'), JSON.stringify(saved))
  const before = f.requests.length
  const result = await runLoop(f.createClient(), f.renderer, { ...f.config, resume: true })
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('recovery_required')
  expect(f.requests.length - before).toBe(0)
  expect(result.iterations).toBe(saved.consumedIterations)
  expect(state(f.sessionDir).consumedIterations).toBe(saved.consumedIterations)
})

it.each(['turn.started', 'turn.finished'] as const)('does not release another iteration after the %s consumer throws', async target => {
  const f = await setup({ onEvent: event => { if (event.type === target) throw new Error('event consumer failed') } })
  const failed = await runLoop(f.client, f.renderer, f.config)
  expect(failed.status).toBe('blocked')
  expect(failed.iterations).toBe(1)
  expect(state(f.sessionDir).current?.phase).toBe(target === 'turn.started' ? 'dispatched' : 'settled')
  const requests = f.requests.length
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.outcomeReason?.code).toBe('recovery_required')
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(requests)
})

it('bounds and redacts multibyte diagnostics in actual retry requests without trimming provider history', async () => {
  const f = await setup({ check: "if (!require('fs').existsSync('fixed.txt')) { console.error('错误 password=fixture-secret\\n'.repeat(10000)); process.exit(1) }",
    respond: (index, res, cwd) => { if (index === 2) writeFileSync(join(cwd, 'fixed.txt'), 'fixed'); reply(res) },
  })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('completed')
  const request = JSON.stringify(f.requests[1])
  expect(request).not.toContain('fixture-secret')
  expect(request).toContain('[REDACTED]')
  expect(Buffer.byteLength(request)).toBeLessThan(40 * 1024)
  const saved = readSessionSnapshot(f.sessionDir).messages
  expect(saved.filter(message => message.providerState).length).toBeGreaterThan(f.client.getModelWindow().filter(message => message.providerState).length)
  const evidence = state(f.sessionDir).previousCheckpoint!.evidence
  const text = readFileSync(join(f.sessionDir, 'loop-controller', evidence.path), 'utf8')
  expect(text).not.toContain('fixture-secret')
  expect(Buffer.byteLength(text)).toBeLessThan(256 * 1024)
  expect(JSON.parse(text).truncated).toBe(true)
})

it('redacts rotated credentials from evidence and retry requests while retaining earlier known keys', async () => {
  const firstKey = 'new-opaque-credential-alpha-12345678'
  const secondKey = 'new-opaque-credential-beta-87654321'
  const f = await setup({ check: `if (!require('fs').existsSync('fixed.txt')) { console.error(${JSON.stringify(`fixture-secret ${firstKey} ${secondKey}`)}); process.exit(1) }`,
    respond: (index, res, cwd) => { if (index === 3) writeFileSync(join(cwd, 'fixed.txt'), 'fixed'); reply(res) },
  })
  let submitted = 0
  const result = await runLoop(f.client, f.renderer, { ...f.config, onPromptSubmit: () => {
    submitted++
    f.client.engine.applyRuntimeConfiguration({ apiKey: submitted === 1 ? firstKey : secondKey })
  } })
  expect(result.status).toBe('completed')
  const finalRetry = JSON.stringify(f.requests[2])
  for (const secret of ['fixture-secret', firstKey, secondKey]) expect(finalRetry).not.toContain(secret)
  const reference = state(f.sessionDir).previousCheckpoint!.evidence
  const evidence = readFileSync(join(f.sessionDir, 'loop-controller', reference.path), 'utf8')
  for (const secret of ['fixture-secret', firstKey, secondKey]) expect(evidence).not.toContain(secret)
  expect(evidence).toContain('[REDACTED]')
})

it('revalidates externally changed completed artifacts without consuming another model turn', async () => {
  const f = await setup()
  const first = await runLoop(f.client, f.renderer, f.config)
  writeFileSync(join(f.cwd, 'new.txt'), 'external change')
  const result = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(result.status).toBe('completed')
  expect(result.runId).toBe(first.runId)
  expect(result.iterations).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(result.verification.artifactVersion).not.toBe(first.verification.artifactVersion)
})

it('retains stagnation stops across resume despite changing STATE notes', async () => {
  const f = await setup({ check: "console.error('same failure'); process.exit(1)", respond: (index, res, cwd) => { writeFileSync(join(cwd, '.loop', 'STATE.md'), `note ${index}`); reply(res) } })
  const first = await runLoop(f.client, f.renderer, f.config)
  expect(first.status).toBe('blocked')
  expect(first.iterations).toBe(3)
  expect(state(f.sessionDir).stagnation.count).toBe(3)
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.runId).toBe(first.runId)
  expect(resumed.iterations).toBe(3)
  expect(f.requests).toHaveLength(3)
})

it.each(['{', '{"stagnationLimit":0}', '{"stagnationLimit":null}', '{"stagnationLimit":3,"extra":true}', ' '.repeat(65537)])('blocks malformed bounded config before submitting', async config => {
  const f = await setup()
  writeFileSync(join(f.loopDir, 'config.json'), config)
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(f.requests).toHaveLength(0)
})

it('blocks explicit iteration conflicts and preserves the frozen maximum for implicit differences', async () => {
  const f = await setup()
  await runLoop(f.client, f.renderer, f.config)
  const conflict = await runLoop(f.client, f.renderer, { ...f.config, resume: true, maxIters: 8, maxItersExplicit: true })
  expect(conflict.status).toBe('blocked')
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true, maxIters: 8 })
  expect(resumed.status).toBe('completed')
  expect(state(f.sessionDir).maxIterations).toBe(4)
  expect(f.requests).toHaveLength(1)
})

it('honors the service deadline without retrying a stalled provider', async () => {
  const f = await setup({ deadlineMs: 1000, finalizationGraceMs: 3000, respond: () => {} })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('limit_reached')
  expect(result.outcomeReason?.code).toBe('turn_deadline')
  expect(f.requests).toHaveLength(1)
})

it('retains human cancellation without starting a final model request', async () => {
  let held: ServerResponse | undefined
  const controller = new AbortController()
  const f = await setup({ respond: (_index, res) => { held = res } })
  const pending = runLoop(f.client, f.renderer, { ...f.config, signal: controller.signal })
  await vi.waitFor(() => expect(held).toBeDefined())
  controller.abort()
  const result = await pending
  expect(result.status).toBe('cancelled')
  expect(f.requests).toHaveLength(1)
  expect(state(f.sessionDir).current?.checkpoint?.decision).toMatchObject({ action: 'stop', status: 'cancelled' })
})

it('retains unconsumed steering and stops without another request', async () => {
  let held: ServerResponse | undefined
  const f = await setup({ respond: (_index, res) => { held = res } })
  const pending = runLoop(f.client, f.renderer, f.config)
  await vi.waitFor(() => expect(held).toBeDefined())
  await f.client.steer('Preserve this pending user instruction')
  reply(held!)
  const result = await pending
  expect(result.status).toBe('interrupted')
  expect(result.outcomeReason?.code).toBe('steering_pending')
  expect(f.requests).toHaveLength(1)
  expect(JSON.stringify(readSessionSnapshot(f.sessionDir).messages)).toContain('Preserve this pending user instruction')
})

it('persists budget denial without another model submission', async () => {
  const f = await setup()
  setBudget(f.cwd, { name: 'requests', type: 'requests', period: 'session', limit: 0, enforced: true, warningThreshold: 0.8, enabled: true })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.outcomeReason).toEqual({ code: 'budget_denied', kind: 'requests' })
  expect(result.status).toBe('limit_reached')
  expect(f.requests).toHaveLength(0)
  expect(state(f.sessionDir).consumedIterations).toBe(1)
})

it.each([false, true])('preserves approval disconnection after an ordinary tool failure (criteria changed: %s)', async changed => {
  const broker = new ApprovalBroker()
  let loopPath = ''
  broker.attachHost({ request: () => { if (changed) writeFileSync(join(loopPath, 'GOAL.md'), 'changed during approval'); broker.disconnectHost('test disconnect'); return new Promise(() => {}) } })
  const f = await setup({ engineConfig: { permissionMode: 'ask', approvalBroker: broker, agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['Read', 'Write'] } }, respond: (index, res, cwd) => {
    const name = index === 1 ? 'Read' : 'Write'
    const args = index === 1 ? { file_path: join(cwd, 'missing.txt') } : { file_path: join(cwd, 'write.txt'), content: 'changed' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  } })
  loopPath = f.loopDir
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status, JSON.stringify(result)).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('recovery_required')
  expect(state(f.sessionDir).current?.terminal?.outcomeReason?.code).toBe('approval_required')
  expect(result.iterations).toBe(1)
  expect(existsSync(join(f.cwd, 'write.txt'))).toBe(false)
})

it.each(['GOAL.md', 'ACCEPTANCE.md', '../artifact.txt'])('rejects external writes to %s during independent checks', async name => {
  const f = await setup({ check: `require('fs').writeFileSync(${JSON.stringify('.loop/' + name)}, 'external write')` })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(existsSync(join(f.loopDir, 'DONE.flag'))).toBe(false)
  expect(f.requests).toHaveLength(1)
})

it('does not reuse a completed task while it is parked', async () => {
  const f = await setup()
  await runLoop(f.client, f.renderer, f.config)
  writeFileSync(join(f.loopDir, 'PARKED.flag'), 'review')
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(f.requests).toHaveLength(1)
})

it('restores normal engine verification after leaving Loop', async () => {
  const f = await setup({ respond: (index, res, cwd) => { if (index === 2) writeFileSync(join(cwd, 'other.txt'), 'ordinary turn change'); reply(res) } })
  await runLoop(f.client, f.renderer, f.config)
  const ordinary = await f.client.runTurn('Make an unrelated change')
  expect(ordinary.result.status).toBe('blocked')
  expect(ordinary.result.verification?.status).toBe('not_applicable')
})

it('does not publish completed authority if a file changes while writing compatibility receipts', async () => {
  const f = await setup()
  const assertOwned = LoopAttemptStore.prototype.assertOwned
  let changed = false
  vi.spyOn(LoopAttemptStore.prototype, 'assertOwned').mockImplementation(function (this: LoopAttemptStore) {
    assertOwned.call(this)
    if (!changed && existsSync(join(f.loopDir, 'OUTCOME.json'))) {
      changed = true
      writeFileSync(join(f.cwd, 'external.txt'), 'changed at publication boundary')
    }
  })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
})

it('preserves the settled obligation after evidence persistence fails', async () => {
  const f = await setup()
  const write = vi.spyOn(LoopAttemptStore.prototype, 'writeEvidence').mockImplementation(() => { throw new Error('disk failure') })
  const failed = await runLoop(f.client, f.renderer, f.config)
  expect(failed.status).toBe('blocked')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
  expect(existsSync(join(f.loopDir, 'DONE.flag'))).toBe(false)
  write.mockRestore()
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.outcomeReason?.code).toBe('recovery_required')
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(1)
})

it.each(['DONE.flag', 'OUTCOME.json'] as const)('retains settled authority when ownership fails before staged %s rename', async leaf => {
  const f = await setup()
  const assertOwned = LoopAttemptStore.prototype.assertOwned
  let lost = false
  vi.spyOn(LoopAttemptStore.prototype, 'assertOwned').mockImplementation(function (this: LoopAttemptStore) {
    assertOwned.call(this)
    if (readdirSync(f.loopDir).some(name => name.endsWith('.tmp')) && (leaf === 'DONE.flag' || existsSync(join(f.loopDir, 'DONE.flag')))) {
      lost = true
      throw new Error('receipt publication ownership lost')
    }
  })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(lost).toBe(true)
  expect(result.status).toBe('blocked')
  expect(result.outcomeReason?.code).toBe('recovery_required')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
  expect(state(f.sessionDir).current?.checkpoint).toBeUndefined()
  expect(existsSync(join(f.loopDir, leaf))).toBe(false)
  expect(readdirSync(f.loopDir).filter(name => name.endsWith('.tmp'))).toEqual([])
  expect(f.requests).toHaveLength(1)
})

it('retains generic blocked service results without retrying or accepting passing Loop checks', async () => {
  const blocker: Tool = { name: 'Blocker', metadata: { readOnly: true, concurrencySafe: true }, definition: { type: 'function', function: { name: 'Blocker', description: 'Explicit generic block', parameters: { type: 'object', properties: {} } } }, execute: async () => ({ content: 'Requires review', isError: true, status: 'blocked' }) }
  const f = await setup({ engineConfig: { extraTools: [blocker], agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['Blocker'] } }, respond: (index, res) => {
    if (index === 2) { reply(res); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'blocked', type: 'function', function: { name: 'Blocker', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  } })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status, JSON.stringify(result)).toBe('blocked')
  expect(result.iterations).toBe(1)
  expect(f.requests).toHaveLength(2)
  expect(state(f.sessionDir).current?.checkpoint?.verificationSource).toBe('turn')
  expect(existsSync(join(f.loopDir, 'DONE.flag'))).toBe(false)
})

it('rejects a frozen verification plan from another workspace before contacting the provider', async () => {
  const f = await setup()
  f.client.engine.getConfig().frozenVerificationPlan = verification.createVerificationPlan(f.base, ['node check.cjs'])
  const result = await f.client.runTurn('Invalid plan')
  expect(result.result.status).toBe('blocked')
  expect(result.result.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(f.requests).toHaveLength(0)
})

it.each(['same', 'other', 'worktree'] as const)('keeps %s workspace Agent acceptance independent of the parent Loop task', async location => {
  let childCwd = ''
  const f = await setup({ check: 'process.exit(1)', respond: (_index, res) => { writeFileSync(join(childCwd, 'child-artifact.txt'), 'changed'); reply(res) } })
  childCwd = location === 'other' ? join(f.base, 'other-workspace') : f.cwd
  mkdirSync(childCwd, { recursive: true })
  writeFileSync(join(childCwd, 'package.json'), '{"scripts":{"test":"node project-check.cjs"}}')
  writeFileSync(join(childCwd, 'project-check.cjs'), `require('fs').appendFileSync(${JSON.stringify(join(f.base, 'project-checks.txt'))},'checked\\n')`)
  if (location === 'worktree') {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: f.cwd, stdio: 'pipe' })
    git('init', '-b', 'main')
    git('add', 'package.json', 'project-check.cjs')
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture')
    childCwd = getWorktreeManager(f.cwd).createWorktree('loop-child').path
  }
  await f.client.initialize()
  new FrozenLoop(f.client, f.cwd, f.loopDir)
  const tool = new AgentTool({ parentConfig: f.client.engine.getConfig(), parentRenderer: f.renderer,
    factory: (config, observer) => new ExecutionEngine(config, observer as EngineObserver),
  })
  const result = await tool.execute({ description: 'independent child', prompt: 'Change the child artifact', verify: true, ...(location === 'worktree' ? { worktree: 'loop-child' } : {}) }, { cwd: location === 'worktree' ? f.cwd : childCwd, permissionMode: 'auto' })
  expect(result.status, JSON.stringify(result)).toBe('completed')
  expect(result.verification?.commands.map(command => command.command)).toEqual(['npm test 2>&1'])
  expect(readFileSync(join(f.base, 'project-checks.txt'), 'utf8')).toBe('checked\n')
  expect(f.requests).toHaveLength(1)
})

it('discards session-bound Loop policy when switching to a different service session', async () => {
  const f = await setup({ respond: (_index, res, cwd) => { writeFileSync(join(cwd, 'other.txt'), 'changed'); reply(res) } })
  await f.client.initialize()
  new FrozenLoop(f.client, f.cwd, f.loopDir)
  const next = join(f.cwd, 'sessions', 'session_next')
  mkdirSync(next)
  await f.client.switchSession(next)
  const result = await f.client.runTurn('Ordinary next session')
  expect(result.result.status).toBe('blocked')
  expect(result.result.verification?.status).toBe('not_applicable')
})

it('rejects changed thresholds on a complete continue checkpoint without resetting it', async () => {
  const f = await setup({ check: "if (!require('fs').existsSync('fixed.txt')) process.exit(1)", respond: (index, res, cwd) => { if (index === 2) writeFileSync(join(cwd, 'fixed.txt'), 'fixed'); reply(res) } })
  const read = LoopAttemptStore.prototype.readEvidence
  const interrupt = vi.spyOn(LoopAttemptStore.prototype, 'readEvidence').mockImplementation(function (this: LoopAttemptStore, reference) {
    if (this.snapshot().current?.phase === 'checkpointed') throw new Error('simulated stop between complete checkpoints')
    return read.call(this, reference)
  })
  const first = await runLoop(f.client, f.renderer, f.config)
  expect(first.status).toBe('blocked')
  expect(state(f.sessionDir).current?.checkpoint?.decision).toEqual({ action: 'continue' })
  interrupt.mockRestore()
  writeFileSync(join(f.loopDir, 'config.json'), '{"stagnationLimit":1}')
  await f.client.dispose()
  const before = state(f.sessionDir)
  const resumed = await runLoop(f.createClient(), f.renderer, { ...f.config, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(resumed.runId).toBe(first.runId)
  expect(resumed.iterations).toBe(1)
  expect(state(f.sessionDir).stagnationLimit).toBe(3)
  expect(state(f.sessionDir)).toEqual(before)
  expect(f.requests).toHaveLength(1)
})

it('does not resubmit while a deadline-cancelled tool still owns a real child process', async () => {
  let child: ChildProcess | undefined
  const tool: Tool = { name: 'PhysicalProbe', metadata: { readOnly: true, concurrencySafe: true },
    definition: { type: 'function', function: { name: 'PhysicalProbe', description: 'Physical child settlement fixture', parameters: { type: 'object', properties: {} } } },
    execute: async () => {
      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
      await once(child, 'exit')
      return { content: 'physically settled', isError: false }
    },
  }
  const f = await setup({ deadlineMs: 1000, finalizationGraceMs: 100, engineConfig: { cancellationGraceMs: 50, extraTools: [tool], agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['PhysicalProbe'] } }, respond: (_index, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'physical', type: 'function', function: { name: 'PhysicalProbe', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  } })
  try {
    const result = await runLoop(f.client, f.renderer, f.config)
    expect(result.status).toBe('blocked')
    expect(result.outcomeReason?.code).toBe('recovery_required')
    expect(child?.exitCode).toBeNull()
    expect(state(f.sessionDir).consumedIterations).toBe(1)
    const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
    expect(resumed.status).toBe('blocked')
    expect(resumed.iterations).toBe(1)
    expect(f.requests).toHaveLength(1)
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  }
})

it('does not publish success after losing the store writer ticket', async () => {
  const f = await setup()
  const execute = verification.executeVerification
  vi.spyOn(verification, 'executeVerification').mockImplementation(async options => {
    const evidence = await execute(options)
    const owners = join(f.sessionDir, 'loop-controller', 'writer.lock.owners')
    writeFileSync(join(owners, readdirSync(owners)[0], 'ticket'), '999999')
    return evidence
  })
  const result = await runLoop(f.client, f.renderer, f.config)
  expect(result.status).toBe('blocked')
  expect(state(f.sessionDir).current?.phase).toBe('settled')
  expect(existsSync(join(f.loopDir, 'DONE.flag'))).toBe(false)
})

it('blocks resume after canonical service history diverges from the checkpoint', async () => {
  const f = await setup()
  await runLoop(f.client, f.renderer, f.config)
  await f.client.replaceHistory([...f.client.getHistory(), { role: 'user', content: 'external instruction' }])
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(resumed.outcomeReason?.code).toBe('recovery_required')
  expect(f.requests).toHaveLength(1)
})

it.each(['GOAL.md', 'ACCEPTANCE.md', '../package.json'])('preserves task identity and consumed attempts when changed %s rejects resume', async file => {
  const f = await setup()
  const first = await runLoop(f.client, f.renderer, f.config)
  const ledger = readFileSync(join(f.sessionDir, 'loop-controller', 'state.json'), 'utf8')
  writeFileSync(join(f.loopDir, file), file.endsWith('.json') ? '{"scripts":{"test":"node check.cjs"}}' : '- [ ] A1: changed `node check.cjs`')
  const resumed = await runLoop(f.client, f.renderer, { ...f.config, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(resumed.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(resumed.runId).toBe(first.runId)
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(1)
  expect(readFileSync(join(f.sessionDir, 'loop-controller', 'state.json'), 'utf8')).toBe(ledger)
})

it.each(['completed', 'continue'] as const)('rejects a goal/acceptance boundary transfer when resuming a %s checkpoint', async decision => {
  const f = await setup({ check: decision === 'continue' ? 'process.exit(1)' : 'process.exit(0)' })
  writeFileSync(join(f.loopDir, 'GOAL.md'), 'Ship the reviewed change\n')
  writeFileSync(join(f.loopDir, 'ACCEPTANCE.md'), 'Must preserve authentication\n- [ ] A1: check `node check.cjs`')
  const read = LoopAttemptStore.prototype.readEvidence
  const pause = vi.spyOn(LoopAttemptStore.prototype, 'readEvidence').mockImplementation(function (this: LoopAttemptStore, reference) {
    if (this.snapshot().current?.checkpoint?.decision.action === 'continue') throw new Error('simulated pause at a complete continue checkpoint')
    return read.call(this, reference)
  })
  const first = await runLoop(f.client, f.renderer, { ...f.config, maxIters: 2 })
  pause.mockRestore()
  expect(state(f.sessionDir).current?.checkpoint?.decision).toMatchObject(decision === 'completed' ? { action: 'stop', status: 'completed' } : { action: 'continue' })
  const ledgerPath = join(f.sessionDir, 'loop-controller', 'state.json')
  const ledger = readFileSync(ledgerPath, 'utf8')
  const submissions = f.requests.length
  await f.client.dispose()
  writeFileSync(join(f.loopDir, 'GOAL.md'), 'Ship the reviewed change\nMust preserve authentication\n')
  writeFileSync(join(f.loopDir, 'ACCEPTANCE.md'), '- [ ] A1: check `node check.cjs`')
  const resumed = await runLoop(f.createClient(), f.renderer, { ...f.config, maxIters: 2, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(resumed.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(resumed.runId).toBe(first.runId)
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(submissions)
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger)
})

it('fails closed when resuming a saved task with the former unframed goal identity', async () => {
  const f = await setup()
  const first = await runLoop(f.client, f.renderer, f.config)
  await f.client.dispose()
  const ledgerPath = join(f.sessionDir, 'loop-controller', 'state.json')
  const saved = state(f.sessionDir)
  saved.goalHash = createHash('sha256').update(readFileSync(join(f.loopDir, 'GOAL.md'))).update(readFileSync(join(f.loopDir, 'ACCEPTANCE.md'))).digest('hex')
  writeFileSync(ledgerPath, JSON.stringify(saved))
  const ledger = readFileSync(ledgerPath, 'utf8')
  const submissions = f.requests.length
  const resumed = await runLoop(f.createClient(), f.renderer, { ...f.config, resume: true })
  expect(resumed.status).toBe('blocked')
  expect(resumed.outcomeReason?.code).toBe('acceptance_invalidated')
  expect(resumed.runId).toBe(first.runId)
  expect(resumed.iterations).toBe(1)
  expect(f.requests).toHaveLength(submissions)
  expect(readFileSync(ledgerPath, 'utf8')).toBe(ledger)
})
