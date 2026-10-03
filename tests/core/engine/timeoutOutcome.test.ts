import type OpenAI from 'openai'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine, type EngineObserver } from '../../../src/core/engine.js'
import { globalModuleRegistry } from '../../../src/core/moduleRegistry.js'
import * as verification from '../../../src/core/verification.js'
import type { EngineConfig } from '../../../src/core/types.js'

const directories: string[] = []
const engines: ExecutionEngine[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const engine of engines.splice(0)) await engine.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

function park(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function setup(create: (cwd: string, signal: AbortSignal) => Promise<AsyncIterable<unknown>>, overrides: Partial<EngineConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-engine-timeout-'))
  directories.push(cwd)
  const client = { chat: { completions: { create: (_params: unknown, options: { signal: AbortSignal }) => create(cwd, options.signal) } } } as unknown as OpenAI
  const observer = new Proxy({}, { get: () => () => undefined }) as EngineObserver
  const engine = new ExecutionEngine({
    cwd, apiKey: 'offline', model: 'test-model', maxIterations: 2,
    permissionMode: 'deny', enabledModules: [], modelGateway: { deadlineMs: 600_000 },
    ...overrides,
  }, observer, client)
  engines.push(engine)
  return { engine, cwd }
}

async function* answer() {
  await Promise.resolve()
  yield { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }
}

describe('engine timeout outcomes', () => {
  it('reports an inactive model stream as failed and preserves its timeout reason', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const started = deferred<AbortSignal>()
    const { engine } = setup((_cwd, signal) => Promise.resolve({
      [Symbol.asyncIterator]: () => ({ next: () => {
        started.resolve(signal)
        return park(signal)
      } }),
    }))
    const pending = engine.runTurn('respond', [])
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(130_001)
    const { result } = await pending
    expect(signal.aborted).toBe(true)
    expect(String(signal.reason)).toMatch(/^timeout:/)
    expect(result).toMatchObject({ status: 'failed', reason: 'error', verification: { status: 'not_run' } })
    expect(result.unfinishedResources).toEqual([])
  })

  it('reports a boot operation timeout as failed after its resources settle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = deferred<AbortSignal>()
    const name = 'timeout-boot-' + Math.random().toString(36).slice(2)
    globalModuleRegistry.register(name, () => ({
      name,
      boot: context => {
        if (!context.abortSignal) throw new Error('Missing boot cancellation signal')
        started.resolve(context.abortSignal)
        return park(context.abortSignal)
      },
    }))
    const { engine } = setup(() => Promise.resolve(answer()), { enabledModules: [name] })
    const pending = engine.runTurn('respond', [])
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(60_001)
    const { result } = await pending
    expect(String(signal.reason)).toBe('timeout:boot:' + name)
    expect(result.status).toBe('failed')
    expect(result.unfinishedResources).toEqual([])
  })

  it('keeps a verification operation timeout failed when cancellation rejects the check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = deferred<AbortSignal>()
    vi.spyOn(verification, 'executeVerification').mockImplementation(async options => {
      const signal = options.signal!
      started.resolve(signal)
      return park(signal)
    })
    const { engine } = setup(cwd => {
      writeFileSync(join(cwd, 'artifact.txt'), 'changed')
      return Promise.resolve(answer())
    })
    const pending = engine.runTurn('respond', [])
    const signal = await started.promise
    await vi.advanceTimersByTimeAsync(300_001)
    const { result } = await pending
    expect(String(signal.reason)).toBe('timeout:verification')
    expect(result).toMatchObject({ status: 'failed', reason: 'error', verification: { status: 'failed' } })
    expect(result.unfinishedResources).toEqual([])
  })

  it('preserves user cancellation as cancelled during boot', async () => {
    const started = deferred<AbortSignal>()
    const name = 'cancel-boot-' + Math.random().toString(36).slice(2)
    globalModuleRegistry.register(name, () => ({
      name,
      boot: context => {
        if (!context.abortSignal) throw new Error('Missing boot cancellation signal')
        started.resolve(context.abortSignal)
        return park(context.abortSignal)
      },
    }))
    const { engine } = setup(() => Promise.resolve(answer()), { enabledModules: [name] })
    const pending = engine.runTurn('respond', [])
    await started.promise
    engine.abort()
    expect((await pending).result.status).toBe('cancelled')
  })

  it('records a real verification process deadline as a failed timed out command', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovo-verification-timeout-'))
    directories.push(cwd)
    const result = await verification.runFileVerificationCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], cwd, undefined, 25)
    expect(result).toMatchObject({ passed: false, timedOut: true, cancelled: false })
    expect(result.unfinishedResources).toBeUndefined()
  })
})
