import { randomUUID } from 'node:crypto'
import { readdirSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { AgentEventStore } from './agentEventStore.js'
import type { AgentEvent, AgentThreadSnapshot } from './agentEvents.js'
import { prepareModelWindow, pruneTurnResults, readModelWindow, saveModelWindow, saveTurnResult } from './agentSession.js'
import type { ExecutionEngine } from './engine.js'
import { eventText, TurnEvents } from './engine/events.js'
import { settleHistory } from './messageGroups.js'
import { resolveModelRuntime } from './modelRuntime.js'
import { normalizeOutcome, settleWithin } from './outcome.js'
import { validateOutputSchema, validateStructuredOutput } from './outputSchema.js'
import { isWorkspaceQuarantined } from './runContext.js'
import {
  canonicalSessionDirectory, claimSessionOwnership, createSessionDir, readSessionSnapshot, releaseSessionOwnership, saveSession,
} from './sessionManager.js'
import type { OpenAIMessage, SteeringInput, TurnResult } from './types.js'
import { runWithDeadline } from '../ui/turnDeadline.js'

export interface AgentEngineContext {
  threadId: string
  cwd: string
  sessionDir: string
}

export interface AgentServiceOptions {
  engineFactory: (context: AgentEngineContext) => ExecutionEngine | Promise<ExecutionEngine>
  deadlineMs?: number
  finalizationGraceMs?: number
}

export interface AgentStartInput {
  threadId?: string
  cwd: string
  text: string
  responseSchema?: Record<string, unknown>
  images?: readonly { path: string; dataUrl: string }[]
}

export interface AgentTurnOutcome {
  result: TurnResult
  newHistory: readonly OpenAIMessage[]
}

interface ServiceTurn {
  turnId: string
  accepting: boolean
  finalized: boolean
  physicalSettled: boolean
  settled: boolean
  steering: SteeringInput[]
  steeringCount: number
  steeringBytes: number
  promise: Promise<AgentTurnOutcome>
}

interface ServiceThread extends AgentEngineContext {
  engine: ExecutionEngine
  store: AgentEventStore
  history: OpenAIMessage[]
  modelWindow: OpenAIMessage[]
  revision: number
  active: ServiceTurn | null
  recoveryRequired: boolean
  turns: Map<string, ServiceTurn>
  subscriptionAbort: AbortController
  subscriptionError?: unknown
  unsubscribeApproval?: () => void
  releasing?: boolean
}

export class AgentServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'AgentServiceError'
  }
}

export const AGENT_TURN_DEADLINE_MS = 10 * 60 * 1000
export const AGENT_FINALIZATION_GRACE_MS = 3000
const MAX_STEERING_MESSAGES = 32
const MAX_STEERING_BYTES = 128 * 1024
const ownedSessions = new Set<string>()

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function workspace(cwd: string): string {
  if (typeof cwd !== 'string' || !cwd.trim()) throw new TypeError('cwd must be a non-empty directory')
  const path = realpathSync(resolve(cwd))
  if (!statSync(path).isDirectory()) throw new TypeError('cwd must be a directory')
  return path
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function failure(turnId: string, error: unknown, status: TurnResult['status'] = 'failed'): TurnResult {
  return { stopped: true, reason: 'error', status, runId: turnId, output: error instanceof Error ? error.message : String(error) }
}

export class AgentService {
  private readonly threads = new Map<string, ServiceThread>()
  private readonly registrations = new Map<string, { cwd: string; promise: Promise<{ threadId: string }> }>()
  private readonly threadLocations = new Map<string, string>()
  private readonly releases = new Map<string, Promise<void>>()
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly options: AgentServiceOptions) {
    for (const value of [options.deadlineMs, options.finalizationGraceMs]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) throw new TypeError('Service timeouts must be positive integers')
    }
  }

  async register(input: { sessionDir: string; cwd: string; engine?: ExecutionEngine }): Promise<{ threadId: string }> {
    this.assertOpen()
    const cwd = workspace(input.cwd)
    const sessionDir = canonicalSessionDirectory(input.sessionDir)
    const key = pathKey(sessionDir)
    const existing = this.registrations.get(key)
    if (existing) {
      if (!samePath(existing.cwd, cwd)) throw new AgentServiceError('workspace_mismatch', 'Session registration belongs to another workspace')
      const registered = await existing.promise
      this.assertAvailable(this.thread(registered.threadId))
      return registered
    }
    const registration = this.registerThread({ ...input, cwd, sessionDir })
    this.registrations.set(key, { cwd, promise: registration })
    try { return await registration } catch (error) { this.registrations.delete(key); throw error }
  }

  private async registerThread(input: { sessionDir: string; cwd: string; engine?: ExecutionEngine }): Promise<{ threadId: string }> {
    const envelope = readSessionSnapshot(input.sessionDir)
    const existing = this.threads.get(envelope.sessionId)
    if (existing) {
      if (!samePath(existing.cwd, input.cwd) || !samePath(existing.sessionDir, input.sessionDir)) throw new AgentServiceError('thread_conflict', 'Thread identity belongs to another workspace or session')
      return { threadId: envelope.sessionId }
    }
    const key = pathKey(input.sessionDir)
    const location = this.threadLocations.get(envelope.sessionId)
    if (location && location !== key) throw new AgentServiceError('thread_conflict', 'Thread identity is already registering another session')
    if (ownedSessions.has(key)) throw new AgentServiceError('session_owned', 'Session is owned by another service')
    ownedSessions.add(key)
    this.threadLocations.set(envelope.sessionId, key)
    let claimed = false
    let store: AgentEventStore | undefined
    let engine: ExecutionEngine | undefined
    try {
      claimSessionOwnership(input.sessionDir)
      claimed = true
      store = new AgentEventStore({ sessionDir: input.sessionDir, cwd: input.cwd, threadId: envelope.sessionId })
      engine = input.engine ?? await this.options.engineFactory({ sessionDir: input.sessionDir, cwd: input.cwd, threadId: envelope.sessionId })
      this.assertOpen()
      if (!samePath(workspace(engine.getConfig().cwd), input.cwd)) throw new AgentServiceError('workspace_mismatch', 'Configured engine belongs to another workspace')
      const boundSession = engine.getConfig().sessionDir
      if (!boundSession || !samePath(canonicalSessionDirectory(boundSession), input.sessionDir)) throw new AgentServiceError('session_mismatch', 'Configured engine must be bound to the registered session')
      engine.getConfig().sessionDir = input.sessionDir
      engine.getConfig().approvalSessionId = envelope.sessionId
      const saved = store.snapshot()
      const thread: ServiceThread = {
        threadId: envelope.sessionId, cwd: input.cwd, sessionDir: input.sessionDir, engine, store,
        history: structuredClone(envelope.messages), modelWindow: readModelWindow(input.sessionDir, envelope.revision, envelope.messages), revision: envelope.revision,
        active: null, recoveryRequired: saved.recovery !== 'clean' || saved.activeTurn !== null || saved.pendingApprovals.length > 0, turns: new Map(), subscriptionAbort: new AbortController(),
      }
      const broker = engine.getConfig().approvalBroker
      if (broker) thread.unsubscribeApproval = broker.subscribe(event => {
        const turn = thread.active
        if (!turn || event.request.runId !== turn.turnId) return
        if (turn.finalized) throw new AgentServiceError('turn_closed', 'Approval arrived after turn finalization')
        if (event.type === 'requested') {
          const { status: _status, ...request } = event.request
          void _status
          const bounded = eventText(request.preview, 32 * 1024)
          const preview = bounded.truncated
            ? `${bounded.text}\n[Durable preview truncated; the approval broker retains the complete input. SHA-256: ${request.inputDigest}]`
            : bounded.text
          thread.store.append({ type: 'approval.requested', turnId: turn.turnId, request: { ...request, preview } })
        } else thread.store.append({ type: 'approval.resolved', turnId: turn.turnId, decision: event.decision })
      })
      this.threads.set(thread.threadId, thread)
      this.releases.delete(thread.threadId)
      return { threadId: thread.threadId }
    } catch (error) {
      try { store?.close() } finally {
        if (claimed) releaseSessionOwnership(input.sessionDir)
        ownedSessions.delete(key)
        this.threadLocations.delete(envelope.sessionId)
        if (engine && engine !== input.engine) await engine.dispose()
      }
      throw error
    }
  }

  async start(input: AgentStartInput): Promise<{ threadId: string; turnId: string }> {
    this.assertOpen()
    input = structuredClone(input)
    if (typeof input.text !== 'string' || !input.text.trim()) throw new TypeError('text must be non-empty')
    if (input.responseSchema) validateOutputSchema(input.responseSchema)
    const cwd = workspace(input.cwd)
    const thread = input.threadId ? await this.resolveThread(input.threadId, cwd) : this.thread((await this.register({ cwd, sessionDir: createSessionDir(cwd) })).threadId)
    this.assertAvailable(thread)
    if (!samePath(thread.cwd, cwd)) throw new AgentServiceError('workspace_mismatch', 'Thread belongs to another workspace')
    if (thread.active) throw new AgentServiceError('turn_active', 'Another turn is active on this thread')
    if (thread.recoveryRequired) throw new AgentServiceError('recovery_required', 'Thread requires explicit recovery before another turn')
    if (isWorkspaceQuarantined(cwd)) throw new AgentServiceError('workspace_quarantined', 'Workspace has unfinished operations')
    if (input.responseSchema && !resolveModelRuntime(thread.engine.getConfig()).options.capabilities.structuredOutput) throw new AgentServiceError('unsupported_output_schema', 'Configured model does not support structured output')
    pruneTurnResults(thread.sessionDir, thread.store.retainedArtifacts())
    const turnId = randomUUID()
    const turn: ServiceTurn = {
      turnId, accepting: true, finalized: false, physicalSettled: false, settled: false, steering: [], steeringCount: 0, steeringBytes: 0,
      promise: Promise.resolve({ result: failure(turnId, 'Turn has not started'), newHistory: [] }),
    }
    try { thread.store.append({ type: 'turn.started', turnId, runId: turnId, cwd, historyRevision: thread.revision }) } catch (error) {
      this.failSubscriptions(thread, error)
      throw error
    }
    for (const [previousId, previous] of thread.turns) if (previous.settled) thread.turns.delete(previousId)
    thread.active = turn
    thread.turns.set(turnId, turn)
    const submitted = structuredClone(input)
    turn.promise = Promise.resolve().then(() => this.execute(thread, turn, submitted))
    void turn.promise.catch(() => {})
    return { threadId: thread.threadId, turnId }
  }

  async steer(threadId: string, expectedTurnId: string, text: string): Promise<void> {
    const thread = this.thread(threadId)
    const turn = this.activeTurn(thread, expectedTurnId)
    if (!turn.accepting) throw new AgentServiceError('turn_closed', 'Turn is no longer accepting steering')
    if (typeof text !== 'string' || !text.trim()) throw new TypeError('Steering text must be non-empty')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (turn.steeringCount >= MAX_STEERING_MESSAGES || turn.steeringBytes + bytes > MAX_STEERING_BYTES) throw new AgentServiceError('steering_limit', 'Turn steering capacity exceeded')
    const input = { id: 'steering:' + randomUUID(), text, recorded: true }
    try {
      thread.store.append({ type: 'item.started', turnId: turn.turnId, itemId: input.id, kind: 'message', role: 'user', expectedTurnId })
      new TurnEvents(turn.turnId, { emit: event => { thread.store.append(event) } }).text(input.id, text)
    } catch (error) { this.failSubscriptions(thread, error); turn.accepting = false; thread.engine.abort(); throw error }
    turn.steering.push(input)
    turn.steeringCount++
    turn.steeringBytes += bytes
    await Promise.resolve()
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    const thread = this.thread(threadId)
    const turn = this.activeTurn(thread, turnId)
    turn.accepting = false
    thread.engine.abort()
    await Promise.resolve()
  }

  subscribe(threadId: string, afterSequence: number, options?: { signal?: AbortSignal }): AsyncIterable<AgentEvent> {
    const thread = this.thread(threadId)
    const signal = options?.signal ? AbortSignal.any([options.signal, thread.subscriptionAbort.signal]) : thread.subscriptionAbort.signal
    const events = thread.store.subscribe(afterSequence, { signal })
    const iterator: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]() { return iterator },
      next: async () => {
        const next = await events.next()
        if (next.done && thread.subscriptionError !== undefined) throw thread.subscriptionError instanceof Error ? thread.subscriptionError : new Error('Agent subscription failed', { cause: thread.subscriptionError })
        return next
      },
      return: () => events.return!(),
      throw: error => events.throw!(error),
    }
    return iterator
  }

  async wait(threadId: string, turnId: string): Promise<AgentTurnOutcome> {
    const turn = this.thread(threadId).turns.get(turnId)
    if (!turn) throw new AgentServiceError('unknown_turn', 'Turn is not owned by this service')
    return structuredClone(await turn.promise)
  }

  async snapshot(threadId: string): Promise<AgentThreadSnapshot> {
    const thread = this.thread(threadId)
    const snapshot = thread.store.snapshot()
    snapshot.historyRevision = thread.revision
    if (thread.recoveryRequired) snapshot.recovery = 'recovery_required'
    return await Promise.resolve(snapshot)
  }

  async getHistory(threadId: string): Promise<readonly OpenAIMessage[]> {
    return await Promise.resolve(structuredClone(this.thread(threadId).history))
  }

  async getModelWindow(threadId: string): Promise<readonly OpenAIMessage[]> {
    return await Promise.resolve(structuredClone(this.thread(threadId).modelWindow))
  }

  async replaceModelWindow(threadId: string, messages: readonly OpenAIMessage[]): Promise<void> {
    const thread = this.thread(threadId)
    this.assertIdle(thread)
    const projection = prepareModelWindow([...messages], true)
    await saveModelWindow(thread.sessionDir, thread.revision, projection)
    thread.modelWindow = projection
  }

  engineForThread(threadId: string): ExecutionEngine {
    return this.thread(threadId).engine
  }

  async replaceHistory(threadId: string, messages: readonly OpenAIMessage[]): Promise<void> {
    const thread = this.thread(threadId)
    this.assertIdle(thread)
    const history = structuredClone([...messages])
    saveSession(thread.sessionDir, history, thread.revision)
    thread.history = history
    thread.modelWindow = prepareModelWindow(history, true)
    thread.revision = readSessionSnapshot(thread.sessionDir).revision
    await saveModelWindow(thread.sessionDir, thread.revision, thread.modelWindow)
  }

  async release(threadId: string): Promise<void> {
    const existing = this.releases.get(threadId)
    if (existing) return existing
    const thread = this.thread(threadId)
    this.assertIdle(thread)
    return this.releaseThread(thread)
  }

  private releaseThread(thread: ServiceThread): Promise<void> {
    const existing = this.releases.get(thread.threadId)
    if (existing) return existing
    thread.releasing = true
    const released = Promise.resolve().then(async () => {
      await thread.engine.dispose()
      thread.unsubscribeApproval?.()
      thread.store.close()
      releaseSessionOwnership(thread.sessionDir)
      ownedSessions.delete(pathKey(thread.sessionDir))
      this.threadLocations.delete(thread.threadId)
      this.threads.delete(thread.threadId)
      this.registrations.delete(pathKey(thread.sessionDir))
    })
    this.releases.set(thread.threadId, released)
    return released
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      const failures: unknown[] = []
      await Promise.allSettled([...this.registrations.values()].map(registration => registration.promise))
      for (const thread of this.threads.values()) {
        if (thread.active) thread.active.accepting = false
        thread.engine.abort()
        if (thread.active) await thread.active.promise.catch(error => { failures.push(error) })
        try { await this.releaseThread(thread) } catch (error) { failures.push(error) }
      }
      if (failures.length) throw new AggregateError(failures, 'Agent service disposal failed')
    })()
    return this.disposal
  }

  private async execute(thread: ServiceThread, turn: ServiceTurn, input: AgentStartInput): Promise<AgentTurnOutcome> {
    const history = structuredClone(thread.history)
    const deadline = runWithDeadline(() => thread.engine.runTurn(input.text, structuredClone(thread.modelWindow), input.images ? structuredClone([...input.images]) : undefined, {
      runId: turn.turnId, responseSchema: input.responseSchema,
      events: { emit: event => {
        if (turn.finalized) throw new AgentServiceError('turn_closed', 'Engine emitted after turn finalization')
        if (event.turnId !== turn.turnId) throw new AgentServiceError('turn_identity_mismatch', 'Engine event belongs to another turn')
        if (event.type === 'item.started' && event.kind === 'verification') turn.accepting = false
        thread.store.append(event)
      } },
      takeSteering: () => {
        const pending = [...turn.steering]
        turn.steering.length = 0
        return pending
      },
    }), { deadlineMs: this.options.deadlineMs ?? AGENT_TURN_DEADLINE_MS, onDeadline: () => { turn.accepting = false; thread.engine.abort() } })
    void deadline.taskSettled.then(() => { turn.physicalSettled = true })
    let result: TurnResult
    let canonical = history
    try {
      let outcome: Awaited<ReturnType<ExecutionEngine['runTurn']>> | undefined
      try { outcome = await deadline.promise } catch (error) {
        try {
          const settled = await settleWithin(deadline.taskSettled, this.options.finalizationGraceMs ?? AGENT_FINALIZATION_GRACE_MS)
          if (settled.status === 'fulfilled') outcome = settled.value
          else result = failure(turn.turnId, settled.reason, deadline.didExpire ? 'limit_reached' : 'failed')
        } catch (finalizationError) {
          result = failure(turn.turnId, finalizationError, 'blocked')
          thread.recoveryRequired = true
        }
        result ??= failure(turn.turnId, error, deadline.didExpire ? 'limit_reached' : 'failed')
      }
      turn.accepting = false
      if (outcome) {
        result = { ...outcome.result, runId: turn.turnId, status: normalizeOutcome(outcome.result) }
        const transcript = (outcome as typeof outcome & { turnMessages?: OpenAIMessage[] }).turnMessages
        if (!transcript) throw new AgentServiceError('missing_turn_transcript', 'Engine did not return its canonical turn transcript')
        canonical = settleHistory([...history, ...structuredClone(transcript)])
        thread.modelWindow = prepareModelWindow(outcome.newHistory)
      }
      result ??= failure(turn.turnId, 'Engine ended without a result')
      if (result.status === 'needs_input') thread.recoveryRequired = true
      if (deadline.didExpire && result.status !== 'blocked') result = { ...result, status: 'limit_reached', reason: 'max_iterations' }
      if (isWorkspaceQuarantined(thread.cwd)) result = { ...result, status: 'blocked', reason: 'error' }
      if (turn.steering.length) {
        for (const steering of turn.steering) {
          canonical.push({ role: 'user', content: steering.text, source: 'runtime' })
          this.completeSteering(thread, turn, steering, 'partial')
        }
        turn.steering.length = 0
        if (result.status === 'completed') result = { ...result, status: 'interrupted', reason: 'interrupted', output: result.output + '\nSteering was retained but was not consumed by this turn.' }
        thread.modelWindow = prepareModelWindow(canonical, true)
      }
      if (input.responseSchema && result.status === 'completed') {
        try { validateStructuredOutput(result.output, input.responseSchema) } catch (error) {
          result = failure(turn.turnId, error)
          thread.store.append({ type: 'error', turnId: turn.turnId, code: 'invalid_structured_output', message: result.output.slice(0, 4096) })
        }
      }
      try {
        saveSession(thread.sessionDir, canonical, thread.revision)
        thread.revision = readSessionSnapshot(thread.sessionDir).revision
        thread.history = structuredClone(canonical)
        await saveModelWindow(thread.sessionDir, thread.revision, thread.modelWindow)
      } catch (error) {
        result = failure(turn.turnId, error)
        thread.recoveryRequired = true
        thread.store.append({ type: 'error', turnId: turn.turnId, code: 'history_persistence_failed', message: result.output.slice(0, 4096) })
      }
      const terminal = await saveTurnResult(thread.sessionDir, turn.turnId, result)
      thread.store.append({ type: 'turn.finished', turnId: turn.turnId, status: result.status ?? 'failed', ...terminal, historyRevision: thread.revision })
      turn.finalized = true
      if (!thread.recoveryRequired) thread.store.checkpoint({ historyRevision: thread.revision, turnId: turn.turnId })
      return { result, newHistory: structuredClone(thread.history) }
    } catch (error) {
      this.failSubscriptions(thread, error)
      turn.accepting = false
      throw error
    } finally {
      deadline.clear()
      turn.settled = true
      if (turn.physicalSettled) {
        if (thread.active === turn) thread.active = null
      } else void deadline.taskSettled.then(() => { if (thread.active === turn) thread.active = null })
    }
  }

  private completeSteering(thread: ServiceThread, turn: ServiceTurn, steering: SteeringInput, status: 'completed' | 'partial'): void {
    const bounded = eventText(steering.text)
    thread.store.append({ type: 'item.completed', turnId: turn.turnId, itemId: steering.id, kind: 'message', role: 'user', expectedTurnId: turn.turnId, status, result: bounded.text, ...(bounded.truncated ? { truncated: true } : {}) })
  }

  private failSubscriptions(thread: ServiceThread, error: unknown): void {
    thread.recoveryRequired = true
    thread.subscriptionError ??= error
    thread.subscriptionAbort.abort()
  }

  private thread(threadId: string): ServiceThread {
    this.assertOpen()
    const thread = this.threads.get(threadId)
    if (!thread) throw new AgentServiceError('unknown_thread', 'Thread is not registered with this service')
    return thread
  }

  private activeTurn(thread: ServiceThread, turnId: string): ServiceTurn {
    const turn = thread.active
    if (!turn || turn.turnId !== turnId || turn.finalized) throw new AgentServiceError('stale_turn', 'Control request does not match the active turn')
    return turn
  }

  private assertIdle(thread: ServiceThread): void {
    this.assertAvailable(thread)
    if (thread.active || isWorkspaceQuarantined(thread.cwd)) throw new AgentServiceError('turn_active', 'Thread has an active turn or unfinished resources')
  }

  private assertAvailable(thread: ServiceThread): void {
    this.assertOpen()
    if (thread.releasing) throw new AgentServiceError('thread_releasing', 'Thread is releasing or has unfinished cleanup')
  }

  private assertOpen(): void {
    if (this.disposed) throw new AgentServiceError('service_disposed', 'Agent service is disposed')
  }

  private async resolveThread(threadId: string, cwd: string): Promise<ServiceThread> {
    const known = this.threads.get(threadId)
    if (known) return known
    let entries: string[]
    try { entries = readdirSync(join(cwd, 'sessions')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentServiceError('unknown_thread', 'Thread does not exist in this workspace')
      throw error
    }
    for (const entry of entries.filter(name => name.startsWith('session_'))) {
      const sessionDir = join(cwd, 'sessions', entry)
      if (readSessionSnapshot(sessionDir).sessionId === threadId) {
        await this.register({ sessionDir, cwd })
        return this.thread(threadId)
      }
    }
    throw new AgentServiceError('unknown_thread', 'Thread does not exist in this workspace')
  }
}
