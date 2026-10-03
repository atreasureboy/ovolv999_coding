import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentTool } from '../../src/tools/agent.js'
import { tmuxLayout } from '../../src/ui/tmuxLayout.js'
import type { EngineConfig } from '../../src/core/types.js'

let cwd: string
let config: EngineConfig
const renderer = { agentStart() {}, agentDone() {}, agentSummary() {}, agentHeartbeat() {} }
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'agent-setup-'))
  config = { cwd, model: 'offline', apiKey: 'offline', maxIterations: 3, permissionMode: 'auto' }
})
afterEach(() => { vi.restoreAllMocks(); rmSync(cwd, { recursive: true, force: true }) })

describe('Agent setup boundaries', () => {
  it('releases its renderer pane if child construction fails', async () => {
    const active = new Set([1])
    vi.spyOn(tmuxLayout, 'acquireSlot').mockReturnValue({ slot: 1, logFile: join(cwd, 'child.log') })
    vi.spyOn(tmuxLayout, 'releaseSlot').mockImplementation(slot => { active.delete(slot) })
    const tool = new AgentTool({ parentConfig: config, parentRenderer: renderer, factory: () => { throw new Error('invalid child configuration') } })
    const result = await tool.execute({ description: 'task', prompt: 'analyse' }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(active.size).toBe(0)
  })

  it.each([0, -1, NaN, Infinity, 1.5])('rejects an invalid max_iterations value before invoking a child: %s', async max_iterations => {
    let invoked = false
    const tool = new AgentTool({ parentConfig: config, parentRenderer: renderer, factory: () => ({
      abort() {}, runTurn() { invoked = true; return Promise.resolve({ result: { reason: 'stop', output: 'done' } }) },
    }) })
    const result = await tool.execute({ description: 'task', prompt: 'analyse', max_iterations }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(invoked).toBe(false)
  })
})
