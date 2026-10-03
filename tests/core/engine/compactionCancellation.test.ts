import type OpenAI from 'openai'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ExecutionEngine, type EngineObserver } from '../../../src/core/engine.js'
import type { OpenAIMessage } from '../../../src/core/types.js'

const engines: ExecutionEngine[] = []
const directories: string[] = []

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function history(contentLength: number): OpenAIMessage[] {
  return Array.from({ length: 40 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(contentLength),
  }))
}

async function cancelCompaction(trigger: 'pressure' | 'reactive'): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-compaction-cancellation-'))
  directories.push(cwd)
  const streamRequests: boolean[] = []
  let started!: (signal: AbortSignal) => void
  const summaryStarted = new Promise<AbortSignal>(resolve => { started = resolve })
  const client = {
    chat: { completions: { create: (params: { stream?: boolean }, options: { signal?: AbortSignal }) => {
      streamRequests.push(params.stream === true)
      if (params.stream) return Promise.reject(new Error('context_length_exceeded'))
      const signal = options.signal
      if (!signal) return Promise.reject(new Error('Compaction has no cancellation signal'))
      started(signal)
      return new Promise<never>((_resolve, reject) => {
        const abort = () => reject(new Error('Request was aborted'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    } } },
  } as unknown as OpenAI
  const observer = new Proxy({}, { get: () => () => undefined }) as EngineObserver
  const engine = new ExecutionEngine({
    cwd,
    model: 'test-model',
    apiKey: 'offline',
    maxIterations: 2,
    maxContextTokens: trigger === 'pressure' ? 20_000 : 64_000,
    permissionMode: 'deny',
    enabledModules: [],
    agent: { identity: { systemPrompt: () => '' }, tools: [] },
  }, observer, client)
  engines.push(engine)
  const pending = engine.runTurn('continue', history(trigger === 'pressure' ? 950 : 200))
  const signal = await Promise.race([
    summaryStarted,
    pending.then(({ result }) => { throw new Error('Run ended before compaction: ' + result.output) }),
  ])
  expect(signal.aborted).toBe(false)
  engine.abort()
  const { result } = await pending
  expect(signal.aborted).toBe(true)
  expect(result.status).toBe('cancelled')
  expect(streamRequests).toEqual(trigger === 'pressure' ? [false] : [true, false])
}

describe('engine compaction cancellation', () => {
  it('cancels a summary started by context pressure', async () => {
    await cancelCompaction('pressure')
  })

  it('cancels a summary started after a provider context overflow', async () => {
    await cancelCompaction('reactive')
  })
})
