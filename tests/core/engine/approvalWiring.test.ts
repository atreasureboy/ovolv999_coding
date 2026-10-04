import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { ApprovalBroker } from '../../../src/core/approvalBroker.js'
import type { EngineConfig, Tool } from '../../../src/core/types.js'
import type { Renderer } from '../../../src/ui/renderer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    await fixture.engine.dispose()
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
})

function setup(overrides: Partial<EngineConfig> = {}, targets = ['approved-target']) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-approval-wiring-'))
  let requests = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    await Promise.resolve()
    if (++requests === 1) {
      yield { choices: [{ delta: { tool_calls: targets.map((target, index) => ({ index, id: `approval-probe-${index}`, function: {
        name: 'ApprovalProbe', arguments: JSON.stringify({ target }),
      } })) }, finish_reason: 'tool_calls' }] }
    } else {
      yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
    }
  })()) } } } as unknown as OpenAI
  const execute = vi.fn(() => Promise.resolve({ content: 'side effect started', isError: false }))
  const tool: Tool = {
    name: 'ApprovalProbe',
    metadata: { readOnly: true, concurrencySafe: true },
    definition: { type: 'function', function: { name: 'ApprovalProbe', description: 'Offline approval probe', parameters: { type: 'object', properties: { target: { type: 'string' } } } } },
    execute,
  }
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const engine = new ExecutionEngine({ cwd, model: 'offline-approval', apiKey: 'offline', permissionMode: 'ask', maxIterations: 2, enabledModules: [], extraTools: [tool], ...overrides }, renderer, client)
  engine.getPermissionManager().addRule({ toolName: 'ApprovalProbe', ruleContent: '*', behavior: 'ask', source: 'user' })
  fixtures.push({ engine, cwd })
  return { engine, execute }
}

describe('engine approval wiring', () => {
  it('rejects a legacy approval after the reviewed input changes', async () => {
    const { engine, execute } = setup({ requestPermission: (_tool, input) => {
      input.target = 'unreviewed-target'
      return Promise.resolve({ approved: true })
    } })
    const turn = await engine.runTurn('request approval', [])
    expect(execute).not.toHaveBeenCalled()
    expect(turn.result.status).toBe('blocked')
  })

  it('rejects a legacy approval after the Engine workspace changes', async () => {
    const { engine, execute } = setup({ requestPermission: () => {
      engine.getConfig().cwd = join(engine.getConfig().cwd, 'different-workspace')
      return Promise.resolve({ approved: true })
    } })
    const turn = await engine.runTurn('request approval', [])
    expect(execute).not.toHaveBeenCalled()
    expect(turn.result.status).toBe('blocked')
  })

  it('routes concurrent real Engine operations through one host and executes each approved input once', async () => {
    const broker = new ApprovalBroker()
    let active = 0
    let maximumActive = 0
    const requests: Array<{ runId: string; operationId: string; inputDigest: string }> = []
    broker.attachHost({ request: async request => {
      requests.push(request)
      maximumActive = Math.max(maximumActive, ++active)
      await new Promise<void>(resolve => setTimeout(resolve, 15))
      active--
      return { requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd, action: 'allow', scope: 'once', status: 'decided' }
    } })
    const { engine, execute } = setup({ approvalBroker: broker }, ['first', 'second', 'third'])
    const turn = await engine.runTurn('request three approvals', [])
    expect(turn.result.status).toBe('completed')
    expect(maximumActive).toBe(1)
    expect(execute.mock.calls).toHaveLength(3)
    expect(requests.map(request => request.runId)).toEqual([turn.result.runId, turn.result.runId, turn.result.runId])
    expect(new Set(requests.map(request => request.operationId)).size).toBe(3)
    expect(new Set(requests.map(request => request.inputDigest)).size).toBe(3)
    expect(broker.pendingSnapshot()).toEqual([])
  })

  it('preserves a structured pending approval when a headless Engine has no host', async () => {
    const broker = new ApprovalBroker()
    const { engine, execute } = setup({ approvalBroker: broker })
    const turn = await engine.runTurn('request approval without a host', [])
    expect(execute.mock.calls).toHaveLength(0)
    expect(turn.result.status).toBe('needs_input')
    expect(broker.pendingSnapshot()).toMatchObject([{ runId: turn.result.runId, tool: 'ApprovalProbe', status: 'needs_input' }])
  })

  it('does not execute when the host approves another directory', async () => {
    const broker = new ApprovalBroker()
    broker.attachHost({ request: request => Promise.resolve({ requestId: request.requestId, inputDigest: request.inputDigest,
      cwd: request.cwd + '/other', action: 'allow', scope: 'once', status: 'decided' }) })
    const { engine, execute } = setup({ approvalBroker: broker })
    const turn = await engine.runTurn('request stale approval', [])
    expect(execute.mock.calls).toHaveLength(0)
    expect(turn.result.status).toBe('blocked')
  })

  it('accepts valid optional undefined fields in a legacy execution profile', async () => {
    const broker = new ApprovalBroker()
    const host = vi.fn(request => Promise.resolve({ requestId: request.requestId, inputDigest: request.inputDigest,
      cwd: request.cwd, action: 'allow' as const, scope: 'once' as const, status: 'decided' as const }))
    broker.attachHost({ request: host })
    const { engine, execute } = setup({ approvalBroker: broker, executionProfile: { mode: 'trusted-local', maxProcesses: undefined } })
    const turn = await engine.runTurn('approve a legacy configured operation', [])
    expect(host).toHaveBeenCalledOnce()
    expect(execute.mock.calls).toHaveLength(1)
    expect(turn.result.status).toBe('completed')
  })

  it('settles cancellation while the host is waiting without executing or retaining the approval', async () => {
    const broker = new ApprovalBroker()
    const host = vi.fn(() => new Promise<never>(() => {}))
    broker.attachHost({ request: host })
    const { engine, execute } = setup({ approvalBroker: broker })
    const pending = engine.runTurn('wait for approval', [])
    await vi.waitFor(() => expect(host).toHaveBeenCalledOnce())
    engine.abort()
    const turn = await pending
    expect(turn.result.status).toBe('cancelled')
    expect(execute.mock.calls).toHaveLength(0)
    expect(broker.pendingSnapshot()).toEqual([])
  })
})
