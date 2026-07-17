/**
 * SnipTool tests — manual context pruning without LLM calls.
 *
 * The tool mutates a live `messages` array via the `snipMessages`
 * callback on `ToolContext`. We provide the callback in tests so the
 * tests stay decoupled from `ExecutionEngine`. Wiring the callback
 * into `runTurn` is exercised indirectly by existing engine tests;
 * this suite covers the tool's contract in isolation.
 */

import { describe, it, expect } from 'vitest'
import { SnipTool } from '../src/tools/snip.js'
import type { ToolContext, OpenAIMessage } from '../src/core/types.js'

// Build a fake conversation: alternating user/assistant turns, content
// carries an index we can assert against.
function makeMessages(n: number): OpenAIMessage[] {
  const msgs: OpenAIMessage[] = []
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: `Message ${i}` })
  }
  return msgs
}

// Stand-in for the engine's `applySnipToMessages` — same algorithm so
// the tool's contract is observed end-to-end. The `tokensFreed` is a
// rough constant here; the real engine reports an estimate via
// `estimateTokens`.
function makeContext(messages: OpenAIMessage[]): ToolContext {
  return {
    cwd: '/test',
    permissionMode: 'auto',
    signal: new AbortController().signal,
    apiConfig: { apiKey: 'test', baseURL: 'http://test', model: 'test' },
    snipMessages: (keepRecent: number) => {
      const total = messages.length
      const removeCount = Math.max(0, total - keepRecent)
      if (removeCount === 0) return { removed: 0, tokensFreed: 0 }
      const kept = messages.slice(-keepRecent)
      messages.length = 0
      messages.push(
        { role: 'user', content: `[snip] ${removeCount} removed` },
        ...kept,
      )
      return { removed: removeCount, tokensFreed: removeCount * 10 }
    },
  }
}

function makeContextWithoutSnip(): ToolContext {
  return {
    cwd: '/test',
    permissionMode: 'auto',
    signal: new AbortController().signal,
    apiConfig: { apiKey: 't', baseURL: 't', model: 't' },
  }
}

describe('SnipTool', () => {
  const tool = new SnipTool()

  it('has correct name', () => {
    expect(tool.name).toBe('Snip')
  })

  it('is not read-only (mutatesState)', () => {
    expect(tool.metadata?.readOnly).toBe(false)
    expect(tool.metadata?.mutatesState).toBe(true)
  })

  it('removes old messages and keeps the specified count', async () => {
    const messages = makeMessages(20)
    const ctx = makeContext(messages)
    const result = await tool.execute({ keep_recent: 5 }, ctx)

    expect(result.isError).toBeFalsy()
    // 5 kept + 1 boundary marker
    expect(messages.length).toBe(6)
    expect(messages[0].content).toContain('[snip]')
    // The first KEPT message is the one at index 20 - 5 = 15.
    expect(messages[1].content).toBe('Message 15')
  })

  it('defaults to keep_recent=10 when not provided', async () => {
    const messages = makeMessages(25)
    const ctx = makeContext(messages)
    await tool.execute({}, ctx)
    expect(messages.length).toBe(11) // 10 kept + 1 boundary
    expect(messages[1].content).toBe('Message 15') // 25 - 10 = 15
  })

  it('defaults to keep_recent=10 when keep_recent is invalid', async () => {
    const messages = makeMessages(25)
    const ctx = makeContext(messages)
    await tool.execute({ keep_recent: -5 }, ctx)
    // Negative falls back to default 10
    expect(messages.length).toBe(11)
  })

  it('does nothing when conversation is already short', async () => {
    const messages = makeMessages(5)
    const ctx = makeContext(messages)
    const result = await tool.execute({ keep_recent: 10 }, ctx)

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('No messages snipped')
    expect(messages.length).toBe(5) // unchanged
  })

  it('passes reason through to the snipMessages callback', async () => {
    const messages = makeMessages(15)
    let capturedReason: string | undefined
    const ctx: ToolContext = {
      cwd: '/test',
      permissionMode: 'auto',
      signal: new AbortController().signal,
      apiConfig: { apiKey: 't', baseURL: 't', model: 't' },
      snipMessages: (_keepRecent: number, reason?: string) => {
        capturedReason = reason
        const total = messages.length
        const removeCount = Math.max(0, total - 3)
        const kept = messages.slice(-3)
        messages.length = 0
        messages.push(
          { role: 'user', content: `[snip] ${removeCount} removed (${reason ?? ''})` },
          ...kept,
        )
        return { removed: removeCount, tokensFreed: removeCount * 10 }
      },
    }

    await tool.execute({ keep_recent: 3, reason: 'old exploration done' }, ctx)

    expect(capturedReason).toBe('old exploration done')
    expect(messages[0].content).toContain('old exploration done')
  })

  it('reports token savings in the success message', async () => {
    const messages = makeMessages(40)
    const ctx = makeContext(messages)
    const result = await tool.execute({ keep_recent: 5 }, ctx)

    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('Snipped 35 old messages')
    expect(result.content).toContain('tokens freed')
    expect(result.content).toContain('Kept last 5 messages')
  })

  it('returns an error when snipMessages is not available', async () => {
    const result = await tool.execute({ keep_recent: 5 }, makeContextWithoutSnip())
    expect(result.isError).toBe(true)
    expect(result.content).toContain('not available')
  })

  it('exposes a JSON-schema definition with the expected parameters', () => {
    const def = tool.definition
    expect(def.type).toBe('function')
    expect(def.function.name).toBe('Snip')
    const props = def.function.parameters.properties
    expect(props).toBeDefined()
    expect(props.keep_recent).toBeDefined()
    expect(props.reason).toBeDefined()
  })
})
