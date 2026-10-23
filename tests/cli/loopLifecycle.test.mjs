import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { root, runNode, isolatedEnv } from '../../scripts/release-utils.mjs'
import { buildExecutionHost } from '../../native/execution-host/build.mjs'
import { reply, startLoopProvider, writeCall } from '../fixtures/loopControllerChild.mjs'

let directory, compiled, sequence = 0
const fixtures = []
beforeAll(async () => {
  const base = join(root, '.artifacts/file-audit')
  mkdirSync(base, { recursive: true })
  directory = mkdtempSync(join(base, 'loop-lifecycle-'))
  compiled = join(directory, 'compiled')
  await runNode(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', compiled])
  if (process.platform === 'win32') buildExecutionHost(join(compiled, 'native/execution-host/bin'))
}, 30_000)
afterAll(async () => {
  for (const fixture of fixtures) await fixture.close()
  if (directory) {
    assert.ok(!relative(join(root, '.artifacts/file-audit'), directory).startsWith('..'))
    rmSync(directory, { recursive: true, force: true })
  }
}, 65_000)

async function fixture({ scenario = 'text', check, permissionMode = 'auto' } = {}) {
  const base = join(directory, `case-${++sequence}`), cwd = join(base, 'workspace'), home = join(base, 'home')
  mkdirSync(cwd, { recursive: true }); mkdirSync(home)
  mkdirSync(join(cwd, '.loop'))
  writeFileSync(join(cwd, '.loop/GOAL.md'), 'Repair the fixture source')
  writeFileSync(join(cwd, '.loop/ACCEPTANCE.md'), '\n- [ ] A1: check `node check.cjs`')
  writeFileSync(join(cwd, 'check.cjs'), check ?? "const fs=require('node:fs');if(!fs.existsSync('source.txt')||fs.readFileSync('source.txt','utf8')!=='fixed'){console.error('FIXTURE_EXPECTED_FIXED');process.exit(1)}")
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode }))
  let turns = 0
  const provider = await startLoopProvider((payload, response, index) => {
    const last = payload.messages.at(-1)
    if (scenario === 'hold') return
    if (scenario === 'repair' && index === 2) return reply(response, writeCall('source.txt', 'fixed'))
    if (scenario === 'effect' && index === 1) return reply(response, { tool_calls: [{ index: 0, id: 'append-effect', type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `node -e "require('node:fs').appendFileSync('effect.txt','once\\n')"` }) } }] })
    if (['note', 'code'].includes(scenario) && last.role !== 'tool') {
      turns++
      if (scenario === 'note') return reply(response, { tool_calls: [{ index: 0, id: `note-${turns}`, type: 'function', function: { name: 'Bash', arguments: JSON.stringify({ command: `node -e "require('node:fs').writeFileSync('.loop/STATE.md',new Date().toISOString())"` }) } }] })
      return reply(response, writeCall(`source-${turns}.txt`, `revision-${turns}`, `write-${turns}`))
    }
    reply(response)
  })
  const env = isolatedEnv(home, { OVOGO_STATE_DIR: join(home, 'runtime'), OPENAI_API_KEY: 'loop-fixture-only', OPENAI_BASE_URL: provider.url, OVOGO_MODEL: 'loop-fixture' })
  const cliArgs = extra => [join(compiled, 'bin/ovogogogo.js'), '--cwd', cwd, ...extra]
  const run = (extra = ['--loop'], more = {}) => runNode(cliArgs(extra), { env, timeout: 25_000, allowFailure: true, ...more })
  const sessions = () => existsSync(join(cwd, 'sessions')) ? readdirSync(join(cwd, 'sessions')).filter(name => name.startsWith('session_')) : []
  const session = () => { expect(sessions()).toHaveLength(1); return join(cwd, 'sessions', sessions()[0]) }
  const ledger = () => JSON.parse(readFileSync(join(session(), 'loop-controller/state.json'), 'utf8'))
  const terminal = () => {
    const path = join(session(), 'agent-events')
    return readdirSync(path).filter(name => name.endsWith('.jsonl')).sort().flatMap(name => readFileSync(join(path, name), 'utf8').trim().split('\n').map(line => JSON.parse(line))).filter(event => event.type === 'turn.finished')
  }
  const unlocked = () => expect(readdirSync(join(session(), 'writer.lock.owners'))).toEqual([])
  const child = barrier => {
    const marker = join(base, 'barrier')
    const instance = spawn(process.execPath, [join(root, 'tests/fixtures/loopControllerChild.mjs'), '--child', compiled, barrier, marker, ...cliArgs(['--loop']).slice(1)], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    instance.stdin.end()
    let stdout = '', stderr = ''
    instance.stdout.on('data', data => { stdout += data }); instance.stderr.on('data', data => { stderr += data })
    const messages = []
    instance.on('message', message => messages.push(message))
    const closed = new Promise((resolve, reject) => { instance.once('error', reject); instance.once('close', (code, signal) => resolve({ code, signal, stdout, stderr })) })
    return { instance, closed, marker, messages }
  }
  const close = async () => {
    const metadataRoot = join(home, '.ovolv999/sessions')
    if (existsSync(metadataRoot)) {
      const { inspectProcessIdentity } = await import(pathToFileURL(join(compiled, 'src/core/processIdentity.js')).href)
      for (const name of readdirSync(metadataRoot).filter(name => name.endsWith('.json'))) {
        const meta = JSON.parse(readFileSync(join(metadataRoot, name), 'utf8'))
        if (['starting', 'running', 'stopping'].includes(meta.status)) await runNode([join(compiled, 'bin/ovogogogo.js'), 'stop', meta.id], { env, timeout: 20_000, allowFailure: true })
        for (const identity of [meta.processIdentity, meta.supervisorIdentity].filter(Boolean)) {
          const end = Date.now() + 15_000
          let status
          do {
            status = await inspectProcessIdentity(identity)
            if (status === 'dead' || status === 'mismatch') break
            await new Promise(resolve => setTimeout(resolve, 50))
          } while (Date.now() < end)
          expect(['dead', 'mismatch'], `Background ${identity.pid} physical termination: ${status}`).toContain(status)
        }
      }
    }
    await provider.close()
  }
  const value = { base, cwd, home, env, provider, run, session, sessions, ledger, terminal, unlocked, child, close }
  fixtures.push(value)
  return value
}

async function until(predicate, detail, timeout = 20_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out waiting for ${detail}`)
}

async function crash(f, barrier) {
  const child = f.child(barrier)
  try {
    await until(() => child.messages.some(message => message.type === 'barrier'), `${barrier} IPC barrier`)
    expect(readFileSync(child.marker, 'utf8')).toBe(barrier)
    return { ledger: f.ledger(), terminal: f.terminal(), requests: f.provider.requests.length }
  } finally {
    child.instance.kill('SIGKILL')
    await child.closed
  }
}

describe('compiled Loop CLI acceptance', () => {
  it('repairs on the second turn using real persisted failure feedback and releases its writer', async () => {
    const f = await fixture({ scenario: 'repair' })
    const result = await f.run()
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(f.provider.requests).toHaveLength(3)
    expect(JSON.stringify(f.provider.requests[1].messages)).toContain('FIXTURE_EXPECTED_FIXED')
    expect(JSON.stringify(f.provider.requests[1].messages)).toContain('node check.cjs')
    expect(readFileSync(join(f.cwd, 'source.txt'), 'utf8')).toBe('fixed')
    expect(f.ledger()).toMatchObject({ consumedIterations: 2, maxIterations: 12, current: { phase: 'checkpointed', checkpoint: { decision: { status: 'completed' }, verificationSource: 'loop' } } })
    expect(f.terminal().map(event => event.status)).toEqual(['completed', 'completed'])
    expect(f.ledger().previousCheckpoint.decision).toEqual({ action: 'continue' })
    expect(JSON.parse(readFileSync(join(f.session(), 'loop-controller', f.ledger().previousCheckpoint.evidence.path), 'utf8')).status).toBe('failed')
    expect(result.stdout).toContain('每轮最多 10 分钟')
    expect(result.stdout).toContain('2/12')
    f.unlocked()
  }, 35_000)

  it.each(['text', 'note'])('blocks at three unchanged failures despite %s runtime activity', async scenario => {
    const f = await fixture({ scenario })
    const result = await f.run()
    expect(result.code).toBe(2)
    expect(f.provider.requests).toHaveLength(scenario === 'text' ? 3 : 6)
    expect(f.ledger()).toMatchObject({ consumedIterations: 3, stagnation: { count: 3 }, current: { phase: 'checkpointed', checkpoint: { decision: { status: 'blocked' } } } })
    expect(f.terminal()).toHaveLength(3)
    expect(result.stdout).toContain('Unchanged acceptance failure repeated 3 times')
    f.unlocked()
  }, 35_000)

  it('counts actual source changes as progress and retains the configured iteration limit', async () => {
    const f = await fixture({ scenario: 'code' })
    const result = await f.run(['--loop', '--loop-max-iters', '4'])
    expect(result.code, result.stdout + result.stderr).toBe(124)
    expect(f.provider.requests).toHaveLength(8)
    expect(f.ledger()).toMatchObject({ consumedIterations: 4, stagnation: { count: 1 }, current: { checkpoint: { decision: { status: 'limit_reached' } } } })
    expect(readFileSync(join(f.cwd, 'source-4.txt'), 'utf8')).toBe('revision-4')
    f.unlocked()
  }, 35_000)

  it('resumes a complete failure checkpoint with feedback, cumulative count, saved limit and project request budget', async () => {
    const f = await fixture()
    mkdirSync(join(f.cwd, '.ovolv999'), { recursive: true })
    writeFileSync(join(f.cwd, '.ovolv999/budgets.json'), JSON.stringify({ budgets: { cli: { name: 'cli', type: 'requests', period: 'daily', limit: 2, enforced: true, warningThreshold: 0.8, enabled: true } }, usage: {}, resets: {} }))
    const first = await crash(f, 'checkpoint')
    expect(first.ledger).toMatchObject({ consumedIterations: 1, stagnation: { count: 1 }, current: { phase: 'checkpointed', checkpoint: { decision: { action: 'continue' } } } })
    const result = await f.run(['--loop', '--resume', f.session()], { env: { ...f.env, OVOGO_LOOP_MAX_ITERS: '20' } })
    expect(result.code, result.stdout + result.stderr).toBe(124)
    expect(f.provider.requests).toHaveLength(2)
    expect(JSON.stringify(f.provider.requests[1].messages)).toContain('FIXTURE_EXPECTED_FIXED')
    expect(f.ledger()).toMatchObject({ taskId: first.ledger.taskId, maxIterations: 12, consumedIterations: 3, stagnation: { count: 2 }, current: { phase: 'checkpointed', checkpoint: { decision: { status: 'limit_reached', reason: { code: 'budget_denied' } } } } })
    const budget = JSON.parse(readFileSync(join(f.cwd, '.ovolv999/budgets.json'), 'utf8'))
    expect(Object.values(budget.usage.cli)).toEqual([2])
    expect(f.terminal().map(event => event.status)).toEqual(['completed', 'completed', 'limit_reached'])
    expect(result.stdout).toContain('3/12')
    f.unlocked()
  }, 40_000)

  it.each(['prepared', 'effect', 'settled'])('does not replay or refund a crash at the %s boundary', async barrier => {
    const f = await fixture({ scenario: barrier === 'effect' ? 'effect' : 'text' })
    const before = await crash(f, barrier)
    expect(before.ledger).toMatchObject({ consumedIterations: 1, current: { phase: barrier === 'effect' ? 'dispatched' : barrier } })
    expect(before.requests).toBe(barrier === 'prepared' ? 0 : 1)
    expect(before.terminal).toHaveLength(barrier === 'settled' ? 1 : 0)
    const result = await f.run(['--loop', '--resume', f.session()])
    expect(result.code).toBe(2)
    expect(f.provider.requests).toHaveLength(before.requests)
    expect(f.ledger()).toEqual(before.ledger)
    expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(barrier === 'effect')
    if (barrier === 'effect') expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8').trim().split('\n')).toEqual(['once'])
    expect(f.terminal()).toEqual(before.terminal)
    f.unlocked()
  }, 35_000)

  it('rejects --continue without a Loop ledger and never searches an older Loop session', async () => {
    const empty = await fixture()
    expect((await empty.run(['--loop', '--continue'])).code).toBe(2)
    expect(empty.sessions()).toEqual([])
    expect(empty.provider.requests).toHaveLength(0)
    const f = await fixture({ check: 'process.exit(0)' })
    expect((await f.run()).code).toBe(0)
    const saved = f.ledger()
    expect((await f.run(['ordinary task'])).code).toBe(0)
    expect(f.sessions()).toHaveLength(2)
    const requests = f.provider.requests.length
    expect((await f.run(['--loop', '--continue'])).code).toBe(2)
    expect(f.provider.requests).toHaveLength(requests)
    expect(f.sessions()).toHaveLength(2)
    expect(JSON.parse(readFileSync(join(f.cwd, 'sessions', f.sessions()[0], 'loop-controller/state.json'), 'utf8'))).toEqual(saved)
  }, 40_000)

  it.each(['workspace', 'goal', 'acceptance', 'threshold', 'limit', 'framing'])('rejects conflicting %s identity without requests or ledger mutation', async conflict => {
    const f = await fixture({ check: 'process.exit(0)' })
    expect((await f.run()).code).toBe(0)
    const before = f.ledger(), savedSession = f.session()
    let extra = ['--loop', '--resume', savedSession]
    if (conflict === 'goal') writeFileSync(join(f.cwd, '.loop/GOAL.md'), 'Changed goal')
    if (conflict === 'acceptance') writeFileSync(join(f.cwd, '.loop/ACCEPTANCE.md'), '- [ ] A1: changed `node check.cjs`')
    if (conflict === 'threshold') writeFileSync(join(f.cwd, '.loop/config.json'), '{"stagnationLimit":4}')
    if (conflict === 'limit') extra.push('--loop-max-iters', '20')
    if (conflict === 'framing') {
      const goal = readFileSync(join(f.cwd, '.loop/GOAL.md'), 'utf8'), acceptance = readFileSync(join(f.cwd, '.loop/ACCEPTANCE.md'), 'utf8')
      writeFileSync(join(f.cwd, '.loop/GOAL.md'), goal + acceptance[0])
      writeFileSync(join(f.cwd, '.loop/ACCEPTANCE.md'), acceptance.slice(1))
    }
    if (conflict === 'workspace') {
      const other = join(f.base, 'other')
      mkdirSync(other); mkdirSync(join(other, '.loop'))
      for (const name of ['GOAL.md', 'ACCEPTANCE.md']) writeFileSync(join(other, '.loop', name), readFileSync(join(f.cwd, '.loop', name)))
      writeFileSync(join(other, 'check.cjs'), 'process.exit(0)')
      extra.push('--cwd', other)
    }
    expect((await f.run(extra)).code).toBe(2)
    expect(f.provider.requests).toHaveLength(1)
    expect(f.ledger()).toEqual(before)
    f.unlocked()
  }, 35_000)

  it('selects the latest incomplete session for --continue without falling back to older completion', async () => {
    const f = await fixture({ check: 'process.exit(0)' })
    expect((await f.run()).code).toBe(0)
    const old = f.session(), before = f.ledger()
    const child = f.child('prepared')
    let latest, pending
    try {
      await until(() => child.messages.some(message => message.type === 'barrier'), 'second session prepared barrier')
      latest = join(f.cwd, 'sessions', f.sessions().sort().at(-1))
      expect(latest).not.toBe(old)
      expect(existsSync(join(latest, 'history.json'))).toBe(false)
      pending = JSON.parse(readFileSync(join(latest, 'loop-controller/state.json'), 'utf8'))
    } finally { child.instance.kill('SIGKILL'); await child.closed }
    expect((await f.run(['--loop', '--continue'])).code).toBe(2)
    expect(f.provider.requests).toHaveLength(1)
    expect(JSON.parse(readFileSync(join(latest, 'loop-controller/state.json'), 'utf8'))).toEqual(pending)
    expect(JSON.parse(readFileSync(join(old, 'loop-controller/state.json'), 'utf8'))).toEqual(before)
    expect(readdirSync(join(latest, 'writer.lock.owners'))).toEqual([])
  }, 35_000)

  it('independently revalidates changed source after completion without another provider call', async () => {
    const f = await fixture({ scenario: 'repair', check: "const fs=require('node:fs');const source=fs.existsSync('source.txt')?fs.readFileSync('source.txt','utf8'):'';console.log('VERIFY_SOURCE='+source);process.exit(source.startsWith('fixed')?0:1)" })
    expect((await f.run()).code).toBe(0)
    const before = f.ledger()
    writeFileSync(join(f.cwd, 'source.txt'), 'fixed externally')
    const result = await f.run(['--loop', '--resume', f.session()])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(f.provider.requests).toHaveLength(3)
    expect(f.ledger()).toMatchObject({ taskId: before.taskId, consumedIterations: 2, current: { phase: 'checkpointed', checkpoint: { decision: { status: 'completed' } } } })
    expect(f.ledger().current.checkpoint.artifactVersion).not.toBe(before.current.checkpoint.artifactVersion)
    const evidence = JSON.parse(readFileSync(join(f.session(), 'loop-controller', f.ledger().current.checkpoint.evidence.path), 'utf8'))
    expect(evidence.output).toContain('VERIFY_SOURCE=fixed externally')
    f.unlocked()
  }, 35_000)

  it('preserves headless approval as needs_input and performs no extra finalization call', async () => {
    const f = await fixture({ scenario: 'effect', permissionMode: 'ask' })
    const result = await f.run(['--loop', '--ink'])
    expect(result.code).toBe(2)
    expect(f.provider.requests).toHaveLength(1)
    expect(existsSync(join(f.cwd, 'effect.txt'))).toBe(false)
    expect(f.ledger()).toMatchObject({ consumedIterations: 1 })
    expect(f.terminal()).toMatchObject([{ status: 'needs_input', result: { outcomeReason: { code: 'approval_required' } } }])
    f.unlocked()
  }, 35_000)

  it('handles the real CLI cancellation listener with exit 130 and no extra provider request', async () => {
    const f = await fixture({ scenario: 'hold' })
    const child = f.child('cancel')
    try {
      await until(() => f.provider.requests.length === 1, 'active provider request')
      child.instance.send({ type: 'cancel' })
      await until(() => child.instance.exitCode !== null, 'cancellation exit', 10_000)
      const result = await child.closed
      expect(result.code).toBe(130)
      expect(f.provider.requests).toHaveLength(1)
      expect(f.ledger()).toMatchObject({ consumedIterations: 1 })
      expect(f.terminal()).toMatchObject([{ status: 'cancelled' }])
      f.unlocked()
    } finally { if (child.instance.exitCode === null) child.instance.kill('SIGKILL'); await child.closed }
  }, 35_000)

  it('propagates a real service iteration limit as 124', async () => {
    const f = await fixture({ scenario: 'effect' })
    const result = await f.run(['--loop', '--max-iter', '1'])
    expect(result.code).toBe(124)
    expect(f.provider.requests).toHaveLength(1)
    expect(readFileSync(join(f.cwd, 'effect.txt'), 'utf8').trim().split('\n')).toEqual(['once'])
    expect(f.ledger()).toMatchObject({ consumedIterations: 1, current: { phase: 'checkpointed', checkpoint: { decision: { status: 'limit_reached' } } } })
    expect(f.terminal()).toMatchObject([{ status: 'limit_reached' }])
    f.unlocked()
  }, 35_000)

  it('runs the genuine background CLI worker through the local provider and persists its outcome', async () => {
    const f = await fixture({ check: 'process.exit(0)' })
    const result = await f.run(['--bg', 'complete background fixture'], { timeout: 30_000 })
    const metadataRoot = join(f.home, '.ovolv999/sessions')
    await until(() => existsSync(metadataRoot) && readdirSync(metadataRoot).some(name => name.endsWith('.json')), 'background metadata')
    const metadataPath = join(metadataRoot, readdirSync(metadataRoot).find(name => name.endsWith('.json')))
    const initial = JSON.parse(readFileSync(metadataPath, 'utf8'))
    expect(result.code, result.stdout + result.stderr + readFileSync(initial.logPath, 'utf8')).toBe(0)
    await until(() => JSON.parse(readFileSync(metadataPath, 'utf8')).exitCode !== undefined, 'background terminal outcome', 30_000)
    const meta = JSON.parse(readFileSync(metadataPath, 'utf8'))
    expect(meta, readFileSync(meta.logPath, 'utf8')).toMatchObject({ status: 'completed', outcome: 'completed', exitCode: 0 })
    expect(f.provider.requests).toHaveLength(1)
    expect(f.terminal()).toMatchObject([{ status: 'completed' }])
    expect(existsSync(join(f.session(), 'loop-controller'))).toBe(false)
    f.unlocked()
  }, 65_000)
})
