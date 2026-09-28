import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { AgentTool } from '../src/tools/agent.js'
import type { ChildEngineLike, EngineConfig } from '../src/core/types.js'

function fixture(run: (cwd: string) => Promise<{ result: { reason: string; output: string } }>, dispose?: () => void | Promise<void>) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovogo-agent-outcome-'))
  const renderer = { agentStart: vi.fn(), agentDone: vi.fn(), agentSummary: vi.fn(), agentHeartbeat: vi.fn() }
  const config: EngineConfig = { cwd, model: 'offline', apiKey: 'offline', permissionMode: 'auto', maxIterations: 2, cancellationGraceMs: 20 }
  const child: ChildEngineLike = { runTurn: () => run(cwd), abort: vi.fn(), dispose }
  const tool = new AgentTool({ parentConfig: config, parentRenderer: renderer, factory: () => child })
  return { cwd, renderer, tool }
}

describe('Agent outcome propagation', () => {
  it('inherits runtime exclusions through child configurations and final evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-agent-runtime-'))
    const inheritedLog = join(cwd, 'inherited', 'events.ndjson')
    const sessionDir = join(cwd, 'sessions', 'session_current')
    mkdirSync(join(cwd, 'inherited'), { recursive: true })
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(inheritedLog, 'first')
    const parentConfig: EngineConfig = { cwd, model: 'offline', apiKey: 'offline', maxIterations: 2, permissionMode: 'auto', sessionDir, verificationExcludedPaths: [inheritedLog] }
    let childConfig: EngineConfig | undefined
    const renderer = { agentStart: vi.fn(), agentDone: vi.fn(), agentSummary: vi.fn(), agentHeartbeat: vi.fn() }
    const tool = new AgentTool({ parentConfig, parentRenderer: renderer, factory: config => {
      childConfig = config
      return { abort() {}, runTurn() {
        writeFileSync(inheritedLog, 'later')
        return Promise.resolve({ result: { reason: 'stop', output: 'analysis only' } })
      } }
    } })
    const result = await tool.execute({ description: 'analysis', prompt: 'analyse' }, { cwd, permissionMode: 'auto', sessionDir })
    expect(result.status).toBe('completed')
    expect(childConfig?.verificationExcludedPaths).toEqual(expect.arrayContaining([inheritedLog, sessionDir]))
  })

  it('invalidates successful verification when disposal changes the accepted artifact', async () => {
    let workspace = ''
    const { tool, cwd, renderer } = fixture((dir) => {
      writeFileSync(join(dir, 'source.txt'), 'verified')
      return Promise.resolve({ result: { reason: 'stop', output: 'changed source' } })
    }, () => { writeFileSync(join(workspace, 'source.txt'), 'changed during disposal') })
    workspace = cwd
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
    const result = await tool.execute({ description: 'task', prompt: 'change source' }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(result.verification?.status).toBe('failed')
    expect(renderer.agentDone.mock.calls).toEqual([['task', false]])
  })

  it('serializes same-workspace child writes through verification and disposal', async () => {
    let active = 0
    let peak = 0
    const { tool, cwd } = fixture(async (dir) => {
      active++
      peak = Math.max(peak, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      writeFileSync(join(dir, 'source.txt'), String(peak))
      return { result: { reason: 'stop', output: 'changed source' } }
    }, () => { active-- })
    await Promise.all([
      tool.execute({ description: 'one', prompt: 'change source' }, { cwd, permissionMode: 'auto' }),
      tool.execute({ description: 'two', prompt: 'change source' }, { cwd, permissionMode: 'auto' }),
    ])
    expect(peak).toBe(1)
    expect(active).toBe(0)
  })
  it('bounds uncooperative cancellation and quarantines the workspace until the child settles', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const controller = new AbortController()
    const { tool, cwd } = fixture(async () => {
      started()
      await pending
      return { result: { reason: 'stop', output: 'late result' } }
    })
    const first = tool.execute({ description: 'task', prompt: 'analyse' }, { cwd, permissionMode: 'auto', signal: controller.signal })
    await ready
    controller.abort()
    expect((await first).isError).toBe(true)
    const blocked = await tool.execute({ description: 'next', prompt: 'analyse' }, { cwd, permissionMode: 'auto' })
    expect(blocked.status).toBe('blocked')
    finish()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect((await tool.execute({ description: 'next', prompt: 'analyse' }, { cwd, permissionMode: 'auto' })).isError).toBe(false)
  }, 1500)
  it('reports child execution failure instead of successful completion', async () => {
    const { tool, cwd, renderer } = fixture(() => Promise.resolve({ result: { reason: 'error', output: 'provider failed' } }))
    const result = await tool.execute({ description: 'task', prompt: 'analyse' }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(renderer.agentDone).toHaveBeenCalledWith('task', false)
  })

  it('executes failing project checks after real edits even with verify false', async () => {
    const { tool, cwd, renderer } = fixture((dir) => {
      writeFileSync(join(dir, 'source.ts'), 'export const value = 2\n')
      return Promise.resolve({ result: { reason: 'stop_sequence', output: 'changed source' } })
    })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }))
    writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('check-ran.txt','yes'); process.exit(7)")
    const result = await tool.execute({ description: 'task', prompt: 'change source', verify: false }, { cwd, permissionMode: 'auto' })
    expect(existsSync(join(cwd, 'check-ran.txt'))).toBe(true)
    expect(result.isError).toBe(true)
    expect(renderer.agentDone.mock.calls).toEqual([['task', false]])
  })

  it('waits for child resource disposal before returning', async () => {
    let disposed = false
    const { tool, cwd } = fixture(() => Promise.resolve({ result: { reason: 'stop', output: 'analysis' } }), async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      disposed = true
    })
    await tool.execute({ description: 'task', prompt: 'analyse' }, { cwd, permissionMode: 'auto' })
    expect(disposed).toBe(true)
  })

  it('does not report success when the parent cancels during disposal', async () => {
    const controller = new AbortController()
    const { tool, cwd, renderer } = fixture(() => Promise.resolve({ result: { reason: 'stop', output: 'analysis' } }), async () => {
      controller.abort()
      await Promise.resolve()
    })
    const result = await tool.execute({ description: 'task', prompt: 'analyse' }, { cwd, permissionMode: 'auto', signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.status).toBe('cancelled')
    expect(renderer.agentDone.mock.calls).toEqual([['task', false]])
  })
})
