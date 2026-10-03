import { describe, expect, it, vi } from 'vitest'
import { ClaudeCodeWorkerManager } from '../../src/core/claudeCodeWorkerManager.js'
import type * as ExecutionBackend from '../../src/core/executionBackend.js'

const options = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../../src/core/executionBackend.js', async importOriginal => ({
  ...await importOriginal<typeof ExecutionBackend>(),
  execManaged: (_command: string, _args: string[], opts: Record<string, unknown>) => {
    options.push(opts)
    return Promise.resolve({ stdout: '', stderr: '' })
  },
}))

describe('Claude worker cancellation and deadlines', () => {
  it('does not report DONE when cancellation occurs during capture', async () => {
    const controller = new AbortController()
    const manager = new ClaudeCodeWorkerManager(() => {
      controller.abort()
      return Promise.resolve({ stdout: '[DONE]', stderr: '' })
    })
    expect(await manager.waitFor({ session: 'fixture', signal: controller.signal })).toMatchObject({ matched: false, aborted: true })
  })

  it('bounds each native tmux request with a timeout', async () => {
    options.length = 0
    await new ClaudeCodeWorkerManager().capture('fixture')
    expect(options[0].timeoutMs).toBeGreaterThan(0)
    expect(options[0].timeoutMs).toBeLessThanOrEqual(5000)
  })
})
