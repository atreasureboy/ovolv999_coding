import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import type { Renderer } from '../../../src/ui/renderer.js'

describe('model request compatibility', () => {
  it('preserves a text-only request when retrying without stream usage support', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovo-model-request-'))
    const requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = []
    const client = {
      chat: {
        completions: {
          create: (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
            requests.push(params)
            if (requests.length === 1)
              return Promise.reject(new Error('stream_options is not supported'))
            return Promise.resolve(
              (async function* () {
                await Promise.resolve()
                yield { choices: [{ delta: { content: 'ready' }, finish_reason: 'stop' }] }
                yield { choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } }
              })(),
            )
          },
        },
      },
    } as unknown as OpenAI
    const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
    const engine = new ExecutionEngine(
      {
        cwd,
        model: 'gpt-4o',
        apiKey: 'offline',
        permissionMode: 'auto',
        maxIterations: 2,
        enabledModules: [],
        agent: { identity: { systemPrompt: () => '' }, tools: [] },
      },
      renderer,
      client,
    )
    try {
      const { result } = await engine.runTurn('respond with text', [])
      expect(result.status).toBe('completed')
      expect(requests).toHaveLength(2)
      expect(requests[0].tools).toBeUndefined()
      expect(requests[1].tools).toBeUndefined()
      expect(requests[1].tool_choice).toBeUndefined()
      expect(requests[1].stream_options).toBeUndefined()
      expect(engine.getCostTracker().getTotalInputTokens()).toBe(5)
      expect(engine.getCostTracker().getTotalAPICalls()).toBe(2)
      expect(engine.getCostTracker().getUsageSummary()).toMatchObject({ actualRequestCount: 1, unknownRequestCount: 1 })
    } finally {
      await engine.dispose()
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
