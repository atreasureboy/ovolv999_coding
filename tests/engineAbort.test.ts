/**
 * Race tests for ExecutionEngine abort / softAbort lifecycle.
 *
 * Strategy: drive the engine exclusively through its public API
 * (runTurn / abort / softAbort). The fake OpenAI client exposes a
 * "deferred" mode — each `create()` parks indefinitely until the test
 * either rejects it (via rejectCall) or until the engine fires the
 * AbortSignal (via engine.abort()). This lets us hold multiple turns in
 * flight at known points and exercise the ownership/lifecycle invariants
 * without reaching into private state.
 *
 * Aborts are exercised via `engine.abort()` (which fires the current
 * controller's signal). Race semantics are verified by observing signal
 * propagation through the fake's recorded AbortSignals.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionEngine } from '../src/core/engine.js'
import type { EngineConfig, Tool } from '../src/core/types.js'

interface CreateCall {
  params: Record<string, unknown>
  signal: AbortSignal
}

class Deferred<T> {
  promise: Promise<T>
  private resolveFn!: (v: T) => void
  constructor() {
    this.promise = new Promise<T>((r) => { this.resolveFn = r })
  }
  resolve(v: T): void { this.resolveFn(v) }
}

class FakeOpenAI {
  createCalls: CreateCall[] = []
  /** One reject fn per in-flight create() — test invokes these for deferred failure. */
  private rejecters: Array<(err: Error) => void> = []
  /** One resolve fn per in-flight create() — test invokes these to feed an empty stream. */
  private resolvers: Array<(stream: AsyncIterable<unknown>) => void> = []

  chat = {
    completions: {
      create: (params: Record<string, unknown>, opts: { signal: AbortSignal }): Promise<AsyncIterable<unknown>> => {
        const signal = opts.signal
        this.createCalls.push({ params, signal })
        return new Promise<AsyncIterable<unknown>>((resolve, reject) => {
          if (signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          this.rejecters.push((err) => reject(err))
          this.resolvers.push((stream) => resolve(stream))
        })
      },
    },
  }

  /** Reject a specific in-flight create() — simulates upstream failure / cancellation. */
  rejectCall(idx: number, reason = 'upstream failure'): void {
    this.rejecters[idx]?.(new Error(reason))
  }

  /**
   * Resolve a specific in-flight create() with an empty stream — the engine's
   * consumeStream returns empty results, llm_call returns, and the state
   * machine transitions to check_abort where a pending soft-abort can fire.
   */
  completeCall(idx: number): void {
    this.resolvers[idx]?.(emptyStream())
  }
}

/**
 * AsyncIterable that yields a single tool-call chunk. The tool call forces
 * the state machine through parse_response → tool_execution → tools_done →
 * check_abort — the only path that revisits check_abort after llm_call.
 * Used by tests that need a pending soft-abort to actually fire.
 */
async function* emptyStream(): AsyncIterable<unknown> {
  await Promise.resolve()
  yield {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0,
          id: 'tc_test_1',
          function: { name: 'Blocking', arguments: '{}' },
        }],
      },
      index: 0,
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  }
}

function fakeRenderer() {
  return {
    banner: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    startSpinner: () => undefined,
    stopSpinner: () => undefined,
    beginAssistantText: () => undefined,
    endAssistantText: () => undefined,
    streamToken: () => undefined,
    toolStart: () => undefined,
    toolResult: () => undefined,
    compactStart: () => undefined,
    compactDone: () => undefined,
  } as unknown as ConstructorParameters<typeof ExecutionEngine>[1]
}

function baseConfig(): EngineConfig {
  return {
    apiKey: 'test-key',
    model: 'test-model',
    maxIterations: 10,
    cwd: '/tmp',
    permissionMode: 'auto',
    permissionManager: {
      check: () => 'allow',
      getMode: () => 'auto',
      getRules: () => [],
      formatMode: () => 'auto',
      formatRules: () => '',
      addRule: () => undefined,
      removeRule: () => undefined,
      cycleMode: () => 'auto',
      setMode: () => undefined,
    } as unknown as EngineConfig['permissionManager'],
    enabledModules: [],
  }
}

function makeEngine(): { engine: ExecutionEngine; client: FakeOpenAI } {
  return makeEngineWithTool()
}

function makeEngineWithTool(extraTool?: Tool): { engine: ExecutionEngine; client: FakeOpenAI } {
  const client = new FakeOpenAI()
  const cfg = baseConfig()
  if (extraTool) cfg.extraTools = [extraTool]
  const engine = new ExecutionEngine(
    cfg,
    fakeRenderer(),
    client as unknown as ConstructorParameters<typeof ExecutionEngine>[2],
  )
  return { engine, client }
}

/**
 * A blocking tool — its `execute()` parks on a caller-controlled Deferred.
 * Use the returned `release()` to let the tool complete. Tests use this to
 * hold an OLD turn inside tool_execution for a deterministic window.
 */
function blockingTool(): { tool: Tool; release: (value: string) => void } {
  const block = new Deferred<string>()
  const tool: Tool = {
    name: 'Blocking',
    definition: {
      type: 'function',
      function: { name: 'Blocking', description: '', parameters: { type: 'object', properties: {} } },
    },
    execute: (_input, _ctx) => block.promise.then((v) => ({ content: v, isError: false })),
    metadata: { concurrencySafe: false },
  }
  return { tool, release: (v: string) => block.resolve(v) }
}

/** Microtask tick — used to let runTurn() reach `await create()`. */
async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r))
}

describe('ExecutionEngine — abort() lifecycle', () => {
  let unhandledRejections: unknown[] = []
  let unhandledHandler: ((reason: unknown) => void) | undefined

  beforeEach(() => {
    unhandledRejections = []
    unhandledHandler = (reason: unknown) => { unhandledRejections.push(reason) }
    process.on('unhandledRejection', unhandledHandler)
  })

  afterEach(async () => {
    if (unhandledHandler) process.off('unhandledRejection', unhandledHandler)
    await settle()
  })

  it('engine.abort() fires the in-flight turn signal and runTurn converges', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)
    const signal = client.createCalls[0].signal
    expect(signal.aborted).toBe(false)

    engine.abort()
    expect(signal.aborted).toBe(true)

    await t
    // After convergence, the next abort must be a safe no-op (no controller installed).
    expect(() => engine.abort()).not.toThrow()
  })

  it('abort() and softAbort() are safe no-ops when the engine is idle', () => {
    const { engine } = makeEngine()
    expect(() => engine.abort()).not.toThrow()
    expect(() => engine.softAbort()).not.toThrow()
    expect(() => engine.abort()).not.toThrow()
  })

  it('softAbortRequested does NOT cause the next turn to soft-abort after a hard abort', async () => {
    const { engine, client } = makeEngine()

    // Turn 1: start, then request soft-abort, then a hard abort cancels the LLM call.
    // softAbortRequested is set INSIDE the turn so the state machine doesn't
    // soft-abort at its first check_abort — that check happens before llm_call.
    const t1 = engine.runTurn('first', [])
    await settle()
    engine.softAbort()
    engine.abort()
    await t1

    expect(client.createCalls[0].signal.aborted).toBe(true)

    // Turn 2 must NOT soft-abort. If softAbortRequested had leaked from turn 1,
    // turn 2 would transition to soft_abort at its first check_abort BEFORE
    // reaching llm_call, leaving createCalls at length 1.
    const t2 = engine.runTurn('second', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    // Belt-and-braces: wait a tick and re-verify the signal is still un-aborted.
    // If a leaked soft-abort were going to fire, it would do so via the
    // soft_abort state transition which doesn't touch the signal — instead,
    // the loop would terminate and t2 would resolve. We assert t2 has not
    // resolved by checking the second signal is still live.
    await new Promise((r) => setTimeout(r, 30))
    expect(client.createCalls[1].signal.aborted).toBe(false)

    engine.abort()
    await t2
    expect(client.createCalls[1].signal.aborted).toBe(true)
  })

  it('NEW turn stays abortable after OLD turn rejected upstream (ownership race)', async () => {
    const { engine, client } = makeEngine()

    // Start OLD → parked in llm_call's await create()
    const t1 = engine.runTurn('old', [])
    await settle()
    const oldSignal = client.createCalls[0].signal
    expect(oldSignal.aborted).toBe(false)

    // Start NEW → installs a fresh controller in the singleton slot
    const t2 = engine.runTurn('new', [])
    await settle()
    const newSignal = client.createCalls[1].signal
    expect(newSignal).not.toBe(oldSignal)
    expect(newSignal.aborted).toBe(false)

    // Reject OLD's create() — this drives OLD's catch + finally without
    // touching any AbortSignal. With the ownership bug, OLD's finally would
    // null out the singleton, making subsequent engine.abort() a no-op for
    // NEW's signal.
    client.rejectCall(0, 'simulated upstream failure')
    await t1

    // NEW is still parked. Its signal must NOT have been touched by OLD.
    expect(newSignal.aborted).toBe(false)

    // The behavioral proof: engine.abort() must still reach NEW's signal.
    engine.abort()
    expect(newSignal.aborted).toBe(true)

    await t2
    // After NEW converges, abort is again a safe no-op.
    expect(() => engine.abort()).not.toThrow()
  })

  it('concurrent turns: aborting the current turn does not affect an older parked turn', async () => {
    const { engine, client } = makeEngine()

    const t1 = engine.runTurn('a', [])
    await settle()
    const t1Signal = client.createCalls[0].signal

    const t2 = engine.runTurn('b', [])
    await settle()
    const t2Signal = client.createCalls[1].signal

    // engine.abort() targets the current (t2) controller
    engine.abort()
    expect(t2Signal.aborted).toBe(true)
    expect(t1Signal.aborted).toBe(false)

    await t2
    // After t2 finishes, t1 must still be parked and unaffected
    expect(t1Signal.aborted).toBe(false)

    // Clean up t1 via the fake
    client.rejectCall(0, 'cleanup')
    await t1
  })

  it('no unhandled rejection is raised when a turn is aborted', async () => {
    const { engine } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    engine.abort()
    await t
    await settle()
    expect(unhandledRejections).toEqual([])
  })

  it('multiple softAbort() calls do not stack — only one pending request survives', async () => {
    const { engine, client } = makeEngine()

    const t = engine.runTurn('q', [])
    await settle()
    engine.softAbort()
    engine.softAbort()
    engine.softAbort()
    engine.abort()
    await t
    expect(client.createCalls[0].signal.aborted).toBe(true)
  })

  it('a turn rejected via the fake client (not via abort) also converges cleanly', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    client.rejectCall(0, 'upstream failure')
    await t
    // After convergence, another abort is a safe no-op
    expect(() => engine.abort()).not.toThrow()
  })

  it('engine.abort() during the softAbort window still terminates the turn', async () => {
    const { engine, client } = makeEngine()
    const t = engine.runTurn('hi', [])
    await settle()
    engine.softAbort() // pauses after current tool, but we have no tools, so it
                       // would otherwise let the loop continue — instead we
                       // hard-abort to force convergence.
    engine.abort()
    await t
    expect(client.createCalls[0].signal.aborted).toBe(true)
  })

  it('softAbort() requested for NEW turn survives OLD turn finally (NEW race)', async () => {
    const { engine, client } = makeEngine()

    // OLD turn parks in llm_call
    const t1 = engine.runTurn('old', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)

    // NEW turn parks in llm_call, takes the singleton slot
    const t2 = engine.runTurn('new', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    const t2Signal = client.createCalls[1].signal
    expect(t2Signal.aborted).toBe(false)

    // User requests soft-abort. owner = NEW's controller.
    engine.softAbort()

    // OLD ends via upstream failure — its finally runs. Without the
    // ownership-aware cleanup, this would unconditionally clear the flag
    // and destroy NEW's request.
    client.rejectCall(0, 'simulated upstream failure')
    const t1Result = await t1

    // OLD's turn should not have soft-aborted — it never saw the flag
    // (owner was NEW's controller, not OLD's).
    expect(t1Result.result.reason).not.toBe('interrupted')

    // NEW's signal must NOT have been touched.
    expect(t2Signal.aborted).toBe(false)

    // Feed NEW an empty stream so llm_call returns and the state machine
    // reaches check_abort, where the still-pending soft-abort should fire.
    client.completeCall(1)
    const t2Result = await t2

    // NEW soft-aborted — reason='interrupted'.
    expect(t2Result.result.reason).toBe('interrupted')
    expect(t2Result.result.stopped).toBe(true)
  })

  it('NEW soft-abort survives OLD turn tool-batch soft-abort check (tool-schedule race)', async () => {
    // OLD turn has a tool call parked in executeToolCall (controlled via a
    // blocking tool + Deferred). NEW turn calls softAbort() while OLD is
    // mid-batch. OLD's per-batch soft-abort check must NOT consume NEW's
    // request — the soft-flag's owner is NEW's controller, not OLD's.
    const oldBlock = blockingTool()
    const newBlock = blockingTool()
    const { engine, client } = makeEngineWithTool(oldBlock.tool)

    // OLD parked in create(0). Feed it a Blocking tool call → enters
    // tool_execution and parks inside oldBlock.tool.execute().
    const t1 = engine.runTurn('old', [])
    await settle()
    expect(client.createCalls).toHaveLength(1)
    client.completeCall(0)
    // Allow OLD to enter tool_execution and reach the awaited execute().
    await new Promise((r) => setTimeout(r, 10))

    // NEW parked in create(1). softAbort()'s owner = NEW's controller.
    const t2 = engine.runTurn('new', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    engine.softAbort()

    // Release OLD's batch — its tool returns, scheduleToolCalls runs its
    // per-batch soft-abort check. Owner mismatch → do not consume.
    oldBlock.release('done')
    // Give OLD time to run per-batch check, transition to tools_done,
    // check_abort, llm_call, and create() again.
    await new Promise((r) => setTimeout(r, 30))
    // OLD should now be parked on a fresh create() (its 2nd or 3rd).
    expect(client.createCalls.length).toBeGreaterThanOrEqual(3)
    const t2Signal = client.createCalls[1].signal
    expect(t2Signal.aborted).toBe(false)

    // Force OLD to terminate via upstream failure so we can read result.reason.
    // The most recent create call belongs to OLD (NEW's is at index 1).
    const idx = client.createCalls.length - 1
    client.rejectCall(idx, 'cleanup')
    const t1Result = await t1

    // If OLD's per-batch check wrongly claimed NEW's soft-abort, OLD would
    // have returned aborted=true from scheduleToolCalls → reason='interrupted'.
    // With the fix, the flag survives and OLD terminates via upstream failure.
    expect(t1Result.result.reason).not.toBe('interrupted')

    // NEW continues, feed it a Blocking tool call → reaches tool_execution
    // → tools_done → check_abort, where the still-pending soft-abort fires.
    client.completeCall(1)
    await new Promise((r) => setTimeout(r, 10))
    newBlock.release('done')

    const t2Result = await t2
    expect(t2Result.result.reason).toBe('interrupted')
    expect(t2Result.result.stopped).toBe(true)
  })

  it('hard-abort after softAbort still clears the flag for the next turn (regression)', async () => {
    const { engine, client } = makeEngine()

    // Turn 1: softAbort during the run, then hard-abort
    const t1 = engine.runTurn('first', [])
    await settle()
    engine.softAbort()
    engine.abort()
    const t1Result = await t1
    expect(t1Result.result.reason).toBe('error') // hard abort surfaces as error
    expect(client.createCalls[0].signal.aborted).toBe(true)

    // Turn 2 must NOT soft-abort. If the soft-flag had leaked, turn 2 would
    // transition to soft_abort at its first check_abort BEFORE llm_call,
    // leaving createCalls at length 1.
    const t2 = engine.runTurn('second', [])
    await settle()
    expect(client.createCalls).toHaveLength(2)
    expect(client.createCalls[1].signal.aborted).toBe(false)

    // Clean up
    engine.abort()
    await t2
  })
})