import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { spawnManaged } from '../../../src/core/executionBackend.js'
import { resolveExecutionPolicy } from '../../../src/core/executionPolicy.js'
import { runFileVerificationCommand } from '../../../src/core/verification.js'
import type { EngineConfig, Tool } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.engine.dispose()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function setup(overrides: Partial<EngineConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-policy-wiring-'))
  let requests = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    if (++requests === 1) {
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'environment-probe', function: {
        name: 'EnvironmentProbe', arguments: '{}',
      } }] }, finish_reason: 'tool_calls' }] }
    } else {
      yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
    }
  })()) } } } as unknown as OpenAI
  const tool: Tool = {
    name: 'EnvironmentProbe',
    metadata: { readOnly: true },
    definition: { type: 'function', function: { name: 'EnvironmentProbe', description: 'Offline environment probe', parameters: { type: 'object', properties: {} } } },
    execute: (_input, context) => new Promise((resolveResult, reject) => {
      const child = spawnManaged(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret:!!process.env.OVO_TEST_SECRET_TOKEN,extra:process.env.OVO_TEST_ALLOWED,path:!!(process.env.PATH||process.env.Path)}))'], { cwd: context.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout?.on('data', data => { output += String(data) })
      child.once('error', reject)
      child.once('close', code => code === 0 ? resolveResult({ content: output, isError: false }) : reject(new Error('Environment probe failed')))
    }),
  }
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({ cwd, model: 'offline-policy', apiKey: 'offline', permissionMode: 'auto', maxIterations: 2, enabledModules: [], extraTools: [tool], ...overrides }, renderer, client)
  fixtures.push({ engine, cwd })
  return engine
}

describe('engine execution policy wiring', () => {
  it('uses minimal child environment even when no caller supplies a profile', async () => {
    vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-fixture-secret')
    vi.stubEnv('OVO_TEST_ALLOWED', 'explicit-extra')
    const engine = setup()
    const turn = await engine.runTurn('inspect the child environment', [])
    const message = turn.newHistory.find(message => message.tool_call_id === 'environment-probe')
    if (typeof message?.content !== 'string') throw new Error('Environment probe did not return text')
    expect(JSON.parse(message.content)).toEqual({ secret: false, path: true })
  })

  it('inherits an explicitly permitted extra variable through the real tool process scope', async () => {
    vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-fixture-secret')
    vi.stubEnv('OVO_TEST_ALLOWED', 'explicit-extra')
    const engine = setup({ executionProfile: { mode: 'trusted-local', envAllowlist: ['PATH', 'Path', 'SYSTEMROOT', 'OVO_TEST_ALLOWED'] } })
    const turn = await engine.runTurn('inspect the child environment', [])
    const message = turn.newHistory.find(message => message.tool_call_id === 'environment-probe')
    if (typeof message?.content !== 'string') throw new Error('Environment probe did not return text')
    expect(JSON.parse(message.content)).toEqual({ secret: false, extra: 'explicit-extra', path: true })
  })

  it('inherits the canonical policy rather than requiring the legacy profile', async () => {
    vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-fixture-secret')
    vi.stubEnv('OVO_TEST_ALLOWED', 'explicit-extra')
    const engine = setup({ executionPolicy: resolveExecutionPolicy({ envAllowlist: ['OVO_TEST_ALLOWED'] }, process.cwd()) })
    const turn = await engine.runTurn('inspect the configured child environment', [])
    const message = turn.newHistory.find(message => message.tool_call_id === 'environment-probe')
    if (typeof message?.content !== 'string') throw new Error('Environment probe did not return text')
    expect(JSON.parse(message.content)).toEqual({ secret: false, extra: 'explicit-extra', path: true })
  })

  it('passes the canonical environment policy to a real direct verification command', async () => {
    vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-fixture-secret')
    vi.stubEnv('OVO_TEST_ALLOWED', 'explicit-extra')
    const result = await runFileVerificationCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({secret:!!process.env.OVO_TEST_SECRET_TOKEN,extra:process.env.OVO_TEST_ALLOWED}))'], process.cwd(), undefined, 5000,
      resolveExecutionPolicy({ envAllowlist: ['OVO_TEST_ALLOWED'] }, process.cwd()))
    expect(result.passed).toBe(true)
    expect(JSON.parse(result.output)).toEqual({ secret: false, extra: 'explicit-extra' })
  })
})
