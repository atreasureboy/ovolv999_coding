import { describe, expect, it } from 'vitest'
import type { ClaudeCodeWorkerManager } from '../src/core/claudeCodeWorkerManager.js'
import { ClaudeCodeTool } from '../src/tools/claudeCode.js'
import type { ToolContext } from '../src/core/types.js'

function context(signal?: AbortSignal): ToolContext {
  return { cwd: '/', permissionMode: 'auto', signal }
}

function fakeManager(overrides: Partial<ClaudeCodeWorkerManager> = {}): ClaudeCodeWorkerManager {
  return {
    syncClaudeEnvironment: () => Promise.resolve([]),
    sessionExists: () => Promise.resolve(true),
    start: () => Promise.resolve({ session: 'worker-1', created: true, syncedEnv: [] }),
    send: () => Promise.resolve(),
    runTask: () => Promise.resolve({ session: 'worker-1', created: true, syncedEnv: [] }),
    capture: () => Promise.resolve('output'),
    waitFor: () => Promise.resolve({ matched: true, output: '[DONE]\nSummary: ok' }),
    list: () => Promise.resolve(['worker-1']),
    stop: () => Promise.resolve(),
    ...overrides,
  } as unknown as ClaudeCodeWorkerManager
}

describe('ClaudeCodeTool', () => {
  it('only treats capture and list as concurrency safe', () => {
    const tool = new ClaudeCodeTool(fakeManager())

    expect(tool.isConcurrencySafe({ action: 'capture' })).toBe(true)
    expect(tool.isConcurrencySafe({ action: 'list' })).toBe(true)
    expect(tool.isConcurrencySafe({ action: 'run' })).toBe(false)
    expect(tool.isConcurrencySafe({ action: 'stop' })).toBe(false)
  })

  it('returns a friendly error when capture session is missing', async () => {
    const tool = new ClaudeCodeTool(fakeManager({ sessionExists: () => Promise.resolve(false) }))

    const result = await tool.execute({ action: 'capture', session: 'missing' }, context())

    expect(result.isError).toBe(true)
    expect(result.content).toContain('session not found')
    expect(result.content).toContain('missing')
  })

  it('passes AbortSignal to waitFor', async () => {
    let seenSignal: AbortSignal | undefined
    const controller = new AbortController()
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: (options) => {
        seenSignal = options.signal
        return Promise.resolve({ matched: false, output: '', aborted: true })
      },
    }))

    await tool.execute({ action: 'wait', session: 'worker-1' }, context(controller.signal))

    expect(seenSignal).toBe(controller.signal)
  })

  it('uses sane default timeout when timeoutMs is invalid', async () => {
    let seenTimeout: number | undefined
    const tool = new ClaudeCodeTool(fakeManager({
      waitFor: (options) => {
        seenTimeout = options.timeoutMs
        return Promise.resolve({ matched: true, output: '[DONE]' })
      },
    }))

    await tool.execute({ action: 'wait', session: 'worker-1', timeoutMs: 'nope' }, context())

    expect(seenTimeout).toBe(120_000)
  })
})
