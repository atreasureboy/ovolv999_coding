import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureArtifactVersion, createVerificationPlan, executeVerification } from '../../src/core/verification.js'
import { createLoopArtifactPolicy, isLoopRuntimeArtifact } from '../../src/core/artifactPolicy.js'
import { acquireWorkspaceLease, canonicalWorkspaceIdentity } from '../../src/core/workspaceLease.js'
import { acquirePersistenceLeaseSync } from '../../src/core/persistenceLock.js'
import { RunStore } from '../../src/core/runStore.js'
import { UsageLedger } from '../../src/core/usageLedger.js'
import { runtimeStateRoot } from '../../src/core/runtimeState.js'
import { getBudgetPath, setBudget } from '../../src/core/budget.js'
import { ExecutionEngine, type EngineObserver } from '../../src/core/engine.js'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(git = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-artifact-policy-'))
  roots.push(cwd)
  const policy = {
    mode: 'loop' as const, workspace: cwd, loopDir: join(cwd, '.loop'),
    sessionDir: join(cwd, '.ovogo', 'sessions', 'current'), budgetPath: join(cwd, 'budget-root', '.ovolv999', 'budgets.json'),
    runtimeRoot: join(cwd, 'runtime'), usageRoot: join(cwd, 'custom-usage'), eventLogPath: join(cwd, 'event-log', 'events.ndjson'),
  }
  const write = (name: string, value = 'runtime') => {
    const path = join(cwd, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value)
  }
  write('source.ts', 'original')
  if (git) {
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    write('.gitignore', 'ignored-source.ts\n')
    write('.loop/STATE.md', 'initial')
    execFileSync('git', ['add', '.gitignore', 'source.ts', '.loop/STATE.md'], { cwd, stdio: 'ignore' })
  }
  const scan = () => captureArtifactVersion(cwd, [], { concurrency: 2, artifactPolicy: policy })
  return { cwd, policy, write, scan }
}

describe.each([false, true])('loop artifact inventory (git=%s)', git => {
  it('keeps state, budget, usage receipts and lease churn out of artifact identity', async () => {
    const { cwd, write, scan } = fixture(git)
    const before = await scan()
    const lease = createHash('sha256').update(canonicalWorkspaceIdentity(cwd)).digest('hex')
    write('.loop/STATE.md', 'changed')
    write('.loop/DONE.flag')
    write('.loop/OUTCOME.json')
    write('.loop/PARKED.flag')
    write('.ovogo/sessions/current/history.json')
    write('budget-root/.ovolv999/budgets.json')
    write(`budget-root/.ovolv999/budgets.json.${randomUUID()}.tmp`)
    write(`runtime/workspaces/${lease}.json`)
    write(`runtime/workspaces/${lease}.json.${randomUUID()}.tmp`)
    write(`custom-usage/${'a'.repeat(64)}/${'b'.repeat(64)}.json`)
    write(`custom-usage/${'a'.repeat(64)}/${'c'.repeat(64)}.pending.json.${randomUUID()}.tmp`)
    write('event-log/events.ndjson')
    write('event-log/events.ndjson.1')
    write('ovogo_progress.json')
    expect(await scan()).toBe(before)
  })

  it.each([
    'untracked-source.ts', 'ignored-source.ts', '.loop/report.md', '.loop/GOAL.md', '.loop/ACCEPTANCE.md', '.loop/config.json',
    '.ovogo/settings.json', '.ovolv999.json', '.ovolv999/settings.json', '.ovolv999/worktrees/feature/code.ts',
    '.ovogo/sessions/current/report.md', '.ovogo/sessions/current/agent-results/report.json',
    '.ovogo/sessions/current/agent-events/report.json', '.ovogo/sessions/current/usage/report.json',
    '.ovogo/sessions/current/file-history/report.md', '.ovogo/sessions/current/tool-results/report.txt',
    '.ovogo/sessions/current/task-outputs/report.log', '.ovogo/sessions/current/agent-logs/report.log',
    'elsewhere/ovogo_progress.json', 'elsewhere/agent_events.ndjson', 'elsewhere/events.ndjson',
    'runtime/runs/report.json', 'runtime/workspaces/other.json', 'custom-usage/report.json',
    '.shell_logs/report.log', '.bg_logs/report.log', 'custom-logs/shell_1234.log',
  ])('counts user artifact %s', async name => {
    const { write, scan } = fixture(git)
    const before = await scan()
    write(name, 'user output')
    expect(await scan()).not.toBe(before)
  })
})

it('binds policy roots to the verification definition without enumerating new receipt UUIDs', () => {
  const { cwd, policy, write } = fixture()
  const plan = () => createVerificationPlan(cwd, ['node -e "process.exit(0)"'], [], undefined, policy)
  const before = plan().definitionHash
  write(`custom-usage/${'a'.repeat(64)}/${'b'.repeat(64)}.json.${randomUUID()}.tmp`)
  expect(plan().definitionHash).toBe(before)
  policy.usageRoot = join(cwd, 'other-usage')
  expect(plan().definitionHash).not.toBe(before)
})

it('normalizes aliases and missing descendants once and freezes the policy roots', async () => {
  const { cwd, policy, write, scan } = fixture()
  const alias = join(cwd, 'alias')
  mkdirSync(policy.sessionDir, { recursive: true })
  symlinkSync(policy.sessionDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const canonical = createLoopArtifactPolicy(policy)
  const aliased = createLoopArtifactPolicy({ ...policy, sessionDir: join(alias, '..', 'alias'), usageRoot: join(alias, 'not-created', 'usage') })
  expect(aliased.sessionDir).toBe(canonical.sessionDir)
  expect(aliased.usageRoot).toBe(join(canonical.sessionDir, 'not-created', 'usage'))
  expect(Object.isFrozen(aliased)).toBe(true)
  expect(createVerificationPlan(cwd, [], [], undefined, canonical).definitionHash)
    .toBe(createVerificationPlan(cwd, [], [], undefined, createLoopArtifactPolicy({ ...policy, sessionDir: alias })).definitionHash)
  const before = await scan()
  write('.ovogo/sessions/current/history.json')
  expect(await captureArtifactVersion(cwd, [], { artifactPolicy: aliased })).toBe(before)
})

it('preserves frozen roots when an originally missing directory becomes a junction', async () => {
  const { cwd, policy, write } = fixture()
  const frozen = createLoopArtifactPolicy(policy)
  const outside = fixture().cwd
  mkdirSync(dirname(policy.sessionDir), { recursive: true })
  symlinkSync(outside, policy.sessionDir, process.platform === 'win32' ? 'junction' : 'dir')
  expect(createLoopArtifactPolicy(frozen)).toBe(frozen)
  expect(isLoopRuntimeArtifact(join(policy.sessionDir, 'history.json'), frozen)).toBe(false)
  write('source.ts', 'source')
  await expect(captureArtifactVersion(cwd, [], { artifactPolicy: frozen })).resolves.toMatch(/^[a-f0-9]{64}$/)
})

it.skipIf(process.platform !== 'win32')('uses the same workspace identity for Windows case aliases', async () => {
  const { cwd, policy, scan } = fixture()
  const aliased = createLoopArtifactPolicy(Object.fromEntries(Object.entries(policy).filter(([key]) => key !== 'mode').map(([key, value]) => [key, value.toUpperCase()])) as Omit<typeof policy, 'mode'>)
  expect(await captureArtifactVersion(cwd.toUpperCase(), [], { artifactPolicy: aliased })).toBe(await scan())
})

it('rejects a policy belonging to another workspace', async () => {
  const first = fixture()
  const second = fixture()
  expect(() => createVerificationPlan(first.cwd, [], [], undefined, second.policy)).toThrow(/workspace/i)
  await expect(captureArtifactVersion(first.cwd, [], { artifactPolicy: second.policy })).rejects.toThrow(/workspace/i)
})

it('keeps junction escapes and sibling prefixes outside managed roots', async () => {
  const { cwd, policy, write } = fixture()
  const outside = fixture().cwd
  mkdirSync(policy.sessionDir, { recursive: true })
  symlinkSync(outside, join(policy.sessionDir, 'agent-results'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(outside, join(policy.sessionDir, 'loop-controller'), process.platform === 'win32' ? 'junction' : 'dir')
  const frozen = createLoopArtifactPolicy(policy)
  expect(isLoopRuntimeArtifact(join(policy.sessionDir, 'agent-results', randomUUID() + '.json'), frozen)).toBe(false)
  expect(isLoopRuntimeArtifact(join(policy.sessionDir, 'loop-controller', 'state.json'), frozen)).toBe(false)
  expect(isLoopRuntimeArtifact(join(cwd, 'custom-usage-sibling', 'a'.repeat(64), 'b'.repeat(64) + '.json'), frozen)).toBe(false)
  write('.loop/STATE.md/real-source.ts')
  expect(isLoopRuntimeArtifact(join(policy.loopDir, 'STATE.md'), frozen)).toBe(false)
  const before = await captureArtifactVersion(cwd, [], { artifactPolicy: frozen })
  write('.loop/STATE.md/real-source.ts', 'changed')
  expect(await captureArtifactVersion(cwd, [], { artifactPolicy: frozen })).not.toBe(before)
})

it('excludes only actual writer formats within bound session and default log roots', async () => {
  const { cwd, policy, write, scan } = fixture()
  const before = await scan()
  const session = '.ovogo/sessions/current/'
  const id = randomUUID()
  const owned = [
    `history.json.tmp.123.1700000000000.${'a'.repeat(16)}`, `agent-model-window.json.tmp-${id}`,
    `agent-results/${id}.json`, `agent-results/${id}.json.tmp-${randomUUID()}`,
    'agent-events/manifest.json', 'agent-events/snapshot.json', 'agent-events/segment-0000000000000001.jsonl',
    `agent-events/snapshot-0000000000000001.json.tmp-${id}`, 'agent_events.ndjson',
    'events.ndjson', 'events.ndjson.1', 'loop-controller/evidence/arbitrary.json',
    `file-history/index.json.tmp.123.1700000000000.${'a'.repeat(16)}`,
    `file-history/${'a'.repeat(32)}/v1700000000000_1`, `file-history/${'a'.repeat(32)}/v1700000000000_1.meta.json`,
    'tool-results/result_1700000000000_abc123.txt', 'task-outputs/task_abcd1234.log.1', 'agent-logs/agent-0.log',
    '.bg_logs/1700000000000_node_server.js_abc1.log', '.bg_logs/1700000000000_node_server.js_follow.log', '.shell_logs/shell_65535.log',
  ]
  for (const name of owned) write(session + name)
  write('.bg_logs/1700000000000_node_server.js_abc1.log')
  write('.shell_logs/shell_1.log')
  write('.ovolv999/worktrees.json')
  write(`.ovolv999/worktrees.json.${id}.tmp`)
  const locks = [join(policy.sessionDir, 'writer'), join(policy.sessionDir, 'agent-events', 'writer'), policy.budgetPath, join(cwd, '.ovolv999', 'worktrees.json')]
  const guards = locks.map(path => acquirePersistenceLeaseSync(path))
  try { expect(await scan()).toBe(before) } finally { for (const guard of guards) guard.release() }
  for (const name of ['history.json.tmp.user', 'agent-results/fake.json', 'agent-events/segment-1.jsonl', 'file-history/index.json.tmp.user', 'tool-results/result_1_user-report.txt', 'task-outputs/task_user.log', '.shell_logs/shell_65536.log', 'writer.lock.owners/fake/ticket']) {
    write(session + name)
    expect(isLoopRuntimeArtifact(join(policy.sessionDir, name), createLoopArtifactPolicy(policy)), name).toBe(false)
  }
})

it('uses the actual usage ledger root and leaves a memory-only ledger without an exclusion', async () => {
  const { cwd, policy, scan } = fixture()
  const ledger = new UsageLedger({ root: policy.usageRoot })
  expect(ledger.getRoot()).toBe(resolve(policy.usageRoot))
  expect(new UsageLedger().getRoot()).toBeUndefined()
  const before = await scan()
  ledger.recordUsage({ familyId: 'family', runId: 'run', requestId: 'request', model: 'model', kind: 'actual', inputTokens: 1, outputTokens: 2 })
  expect(await scan()).toBe(before)
  expect(await captureArtifactVersion(cwd, [], { artifactPolicy: createLoopArtifactPolicy({ ...policy, usageRoot: undefined }) })).not.toBe(before)
})

it('ignores real leases, budgets and validated run records but counts corrupt or foreign records', async () => {
  const { cwd, policy, write, scan } = fixture()
  const prior = process.env.OVOGO_STATE_DIR
  process.env.OVOGO_STATE_DIR = policy.runtimeRoot
  try {
    expect(runtimeStateRoot()).toBe(policy.runtimeRoot)
    const before = await scan()
    const lease = await acquireWorkspaceLease(cwd)
    const run = new RunStore(policy.runtimeRoot, { workspace: cwd, runId: 'Test_Run-1' })
    setBudget(join(cwd, 'budget-root'), { name: 'requests', type: 'requests', period: 'daily', limit: 5 })
    expect(getBudgetPath(join(cwd, 'budget-root'))).toBe(policy.budgetPath)
    const guard = acquirePersistenceLeaseSync(run.path)
    try { expect(await scan()).toBe(before) } finally { guard.release(); lease.release() }
    run.finish('completed')
    expect(await scan()).toBe(before)
    write('runtime/runs/Test_Run-1.json', '{broken')
    expect(await scan()).not.toBe(before)
    const foreign = new RunStore(policy.runtimeRoot, { workspace: fixture().cwd, runId: 'foreign' })
    expect(isLoopRuntimeArtifact(foreign.path, createLoopArtifactPolicy(policy))).toBe(false)
  } finally {
    if (prior === undefined) delete process.env.OVOGO_STATE_DIR
    else process.env.OVOGO_STATE_DIR = prior
  }
})

it.each(['runtime', 'report', 'finalization'] as const)('uses the same policy through engine acceptance and %s writes', async kind => {
  const { cwd, policy, write } = fixture()
  const previous = process.env.OVOGO_STATE_DIR
  process.env.OVOGO_STATE_DIR = policy.runtimeRoot
  write('package.json', JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      write(kind === 'report' ? '.ovogo/sessions/current/report.md' : '.loop/STATE.md', 'model turn output')
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'ready' }, finish_reason: 'stop' }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n')
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server unavailable')
  const engine = new ExecutionEngine({
    cwd, sessionDir: policy.sessionDir, budgetRoot: join(cwd, 'budget-root'), artifactPolicy: policy,
    usageLedger: new UsageLedger({ root: policy.usageRoot }), apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`,
    model: 'fixture-model', modelProtocol: 'chat-completions', maxContextTokens: 16000, maxOutputTokens: 100,
    maxIterations: 1, enabledModules: [], permissionMode: 'deny', agent: { identity: { systemPrompt: () => 'Requirements' }, tools: [] },
    hookRunner: {
      runPreToolCall: () => [], runPostToolCall: () => [], runUserPromptSubmit: () => [],
      runOnComplete: () => { write(kind === 'finalization' ? '.ovogo/sessions/current/final-report.md' : '.loop/STATE.md', 'finalization'); return [] },
    },
  }, new Proxy({}, { get: () => () => undefined }) as EngineObserver)
  try {
    setBudget(join(cwd, 'budget-root'), { name: 'requests', type: 'requests', period: 'daily', limit: 5 })
    const { result } = await engine.runTurn('Complete work', [])
    expect(result.status, result.output + '\n' + result.verification?.output).toBe(kind === 'finalization' ? 'blocked' : 'completed')
    expect(result.verification?.status).toBe(kind === 'report' ? 'passed' : kind === 'runtime' ? 'not_applicable' : 'failed')
    if (kind === 'finalization') expect(result.outcomeReason).toEqual({ code: 'acceptance_invalidated' })
  } finally {
    await engine.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (previous === undefined) delete process.env.OVOGO_STATE_DIR
    else process.env.OVOGO_STATE_DIR = previous
  }
}, 20000)

it('retains file, byte and timeout bounds in loop mode', async () => {
  const { cwd, policy, write } = fixture()
  write('second.ts', 'second')
  await expect(captureArtifactVersion(cwd, [], { artifactPolicy: policy, maxFiles: 1 })).rejects.toThrow(/file budget/i)
  await expect(captureArtifactVersion(cwd, [], { artifactPolicy: policy, maxBytes: 1 })).rejects.toThrow(/byte budget/i)
  await expect(captureArtifactVersion(cwd, [], { artifactPolicy: policy, timeoutMs: 1 })).rejects.toThrow()
})

it('binds only the main repository manifest when scanning a linked worktree', async () => {
  const main = fixture(true)
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture'], { cwd: main.cwd, stdio: 'ignore' })
  const linked = fixture()
  rmSync(linked.cwd, { recursive: true, force: true })
  execFileSync('git', ['worktree', 'add', '--detach', linked.cwd], { cwd: main.cwd, stdio: 'ignore' })
  const policy = createLoopArtifactPolicy(linked.policy)
  const mainManifest = join(main.cwd, '.ovolv999', 'worktrees.json')
  expect(isLoopRuntimeArtifact(mainManifest, policy)).toBe(true)
  expect(isLoopRuntimeArtifact(join(linked.cwd, '.ovolv999', 'worktrees.json'), policy)).toBe(false)
  const before = await captureArtifactVersion(linked.cwd, [], { artifactPolicy: policy })
  linked.write('.ovolv999/worktrees.json', 'user artifact')
  expect(await captureArtifactVersion(linked.cwd, [], { artifactPolicy: policy })).not.toBe(before)
  main.write('.ovolv999/worktrees.json', 'managed manifest')
  const plan = createVerificationPlan(linked.cwd, [], [], undefined, policy)
  expect(JSON.stringify(plan.artifactPolicy)).toContain('worktreeManifestPath')
})

it('does not assign a manifest exclusion from invalid Git metadata', () => {
  const { cwd, policy, write } = fixture()
  write('.git', 'gitdir: missing-location')
  expect(isLoopRuntimeArtifact(join(cwd, '.ovolv999', 'worktrees.json'), createLoopArtifactPolicy(policy))).toBe(false)
})

it('accepts a frozen verification plan through a workspace junction alias', async () => {
  const { cwd, policy } = fixture()
  const alias = join(fixture().cwd, 'workspace-alias')
  symlinkSync(cwd, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const plan = createVerificationPlan(cwd, ['node -e "process.exit(0)"'], [], undefined, policy)
  const evidence = await executeVerification({ cwd: alias, plan })
  expect(evidence.status, evidence.output).toBe('passed')
  expect(evidence.workspace).toBe(canonicalWorkspaceIdentity(cwd))
})
