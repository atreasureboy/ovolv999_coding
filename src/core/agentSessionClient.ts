import { isDeepStrictEqual } from 'node:util'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { AgentService, AgentServiceError } from './agentService.js'
import type { AgentEvent } from './agentEvents.js'
import { ExecutionEngine } from './engine.js'
import { bindEngineSession } from './engineSession.js'
import type { EngineObserver } from './engine/observer.js'
import { createSessionDir, readSessionSnapshot } from './sessionManager.js'
import { isWorkspaceQuarantined, quarantineWorkspace } from './runContext.js'
import { settleWithin } from './outcome.js'
import type { OpenAIMessage, TurnResult } from './types.js'

export interface AgentSessionClientOptions {
  engine: ExecutionEngine
  observer: EngineObserver
  cwd: string
  sessionDir?: string
  history?: readonly OpenAIMessage[]
  onEvent?: (event: AgentEvent) => void | Promise<void>
  deadlineMs?: number
  finalizationGraceMs?: number
}

export class AgentSessionClient {
  private readonly service: AgentService
  private currentEngine: ExecutionEngine
  private directory: string
  private identity?: string
  private history: OpenAIMessage[]
  private modelWindow: OpenAIMessage[] = []
  private ready?: Promise<void>
  private operation?: Promise<unknown>
  private active?: { threadId: string; turnId: string }
  private cancelledBeforeStart = false
  private delivery?: AbortController
  private promptController?: AbortController
  private pendingPromptHook?: Promise<unknown>
  private disposed = false
  private disposal?: Promise<void>

  constructor(private readonly options: AgentSessionClientOptions) {
    this.currentEngine = options.engine
    this.directory = resolve(options.sessionDir ?? options.engine.getConfig().sessionDir ?? createSessionDir(options.cwd))
    this.history = structuredClone([...(options.history ?? [])])
    this.service = new AgentService({ engineFactory: context => this.createEngine(context.sessionDir), deadlineMs: options.deadlineMs, finalizationGraceMs: options.finalizationGraceMs })
  }

  get engine(): ExecutionEngine { return this.currentEngine }
  get sessionDir(): string { return this.directory }
  get threadId(): string | undefined { return this.identity }
  get activeTurnId(): string | undefined { return this.active?.turnId }
  getHistory(): OpenAIMessage[] { return structuredClone(this.history) }
  getModelWindow(): OpenAIMessage[] { return structuredClone(this.modelWindow) }

  initialize(): Promise<void> {
    if (this.disposed) return Promise.reject(new AgentServiceError('client_disposed', 'Session client is disposed'))
    this.ready ??= this.initializeSession()
    return this.ready
  }

  private async initializeSession(): Promise<void> {
    const saved = readSessionSnapshot(this.directory)
    if (saved.revision > 0 || saved.messages.length) this.history = structuredClone(saved.messages)
    const initial = this.currentEngine
    const bound = initial.getConfig().sessionDir
    const engine = bound && this.samePath(bound, this.directory) ? initial : this.createEngine(this.directory)
    try {
      const { threadId } = await this.service.register({ sessionDir: this.directory, cwd: this.options.cwd, engine })
      this.currentEngine = engine
      this.identity = threadId
      if (!saved.revision && !saved.messages.length && this.history.length) await this.service.replaceHistory(threadId, this.history)
      await this.refresh()
    } catch (error) {
      if (engine !== initial && !this.identity) await engine.dispose()
      throw error
    } finally {
      if (engine !== initial) await initial.dispose()
    }
  }

  runTurn(text: string, images?: readonly { path: string; dataUrl: string }[], onPromptSubmit?: (signal: AbortSignal) => unknown): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    const submittedImages = images ? structuredClone([...images]) : undefined
    if (!this.operation) this.cancelledBeforeStart = false
    return this.exclusive(async () => {
      await this.initialize()
      this.assertOpen()
      if (this.cancelledBeforeStart) throw new DOMException('Turn cancelled before start', 'AbortError')
      if (onPromptSubmit) await this.submitPrompt(onPromptSubmit)
      if (this.cancelledBeforeStart) throw new DOMException('Turn cancelled before start', 'AbortError')
      const threadId = this.identity!
      const before = await this.service.snapshot(threadId)
      const delivery = new AbortController()
      this.delivery = delivery
      this.active = await this.service.start({ threadId, cwd: this.options.cwd, text, images: submittedImages })
      if (this.cancelledBeforeStart) await this.service.interrupt(threadId, this.active.turnId)
      const completion = this.service.wait(threadId, this.active.turnId)
      let failure: unknown
      void completion.catch(error => { failure = error; delivery.abort(error) })
      let terminal = false
      try {
        for await (const event of this.service.subscribe(threadId, before.lastSequence, { signal: delivery.signal })) {
          if (this.options.onEvent) await this.deliver(event, delivery.signal)
          if (event.type === 'turn.finished' && event.turnId === this.active.turnId) { terminal = true; break }
        }
        if (!terminal) throw failure instanceof Error ? failure : new Error('Session event stream ended before its durable result')
        const outcome = await completion
        await this.refresh()
        return { result: outcome.result, newHistory: this.getHistory() }
      } catch (error) {
        await this.service.interrupt(threadId, this.active.turnId).catch(() => {})
        await completion.catch(() => {})
        await this.refresh().catch(() => {})
        throw error
      } finally {
        delivery.abort()
        this.delivery = undefined
        this.active = undefined
      }
    })
  }

  replaceHistory(messages: readonly OpenAIMessage[]): Promise<void> {
    const snapshot = structuredClone([...messages])
    return this.exclusive(async () => {
      await this.initialize()
      if (!isDeepStrictEqual(this.history, snapshot)) await this.service.replaceHistory(this.identity!, snapshot)
      await this.refresh()
    })
  }

  replaceModelWindow(messages: readonly OpenAIMessage[]): Promise<void> {
    const snapshot = structuredClone([...messages])
    return this.exclusive(async () => { await this.initialize(); await this.service.replaceModelWindow(this.identity!, snapshot); await this.refresh() })
  }

  switchSession(sessionDir: string): Promise<OpenAIMessage[]> {
    return this.exclusive(async () => { await this.initialize(); return this.switchTo(sessionDir) })
  }

  recover(): Promise<OpenAIMessage[]> {
    return this.exclusive(async () => {
      if (isWorkspaceQuarantined(this.options.cwd)) throw new AgentServiceError('workspace_quarantined', 'Inspect unfinished workspace operations before creating a recovery session')
      await this.ready?.catch(() => {})
      const saved = readSessionSnapshot(this.directory)
      return this.switchTo(createSessionDir(this.options.cwd), saved.messages)
    })
  }

  async interrupt(expectedTurnId?: string): Promise<void> {
    if (!this.active) {
      if (expectedTurnId) throw new AgentServiceError('stale_turn', 'Control request does not match the active turn')
      if (this.operation) this.cancelledBeforeStart = true
      if (this.pendingPromptHook) {
        quarantineWorkspace(this.options.cwd, this.pendingPromptHook)
        this.promptController?.abort(new DOMException('Turn cancelled before model start', 'AbortError'))
      }
      return
    }
    await this.service.interrupt(this.active.threadId, expectedTurnId ?? this.active.turnId)
  }

  async steer(text: string, expectedTurnId?: string): Promise<void> {
    if (!this.active) throw new AgentServiceError('stale_turn', 'No active turn accepts steering')
    await this.service.steer(this.active.threadId, expectedTurnId ?? this.active.turnId, text)
  }

  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.disposal = (async () => {
      await this.ready?.catch(() => {})
      this.delivery?.abort(new Error('Session client disposed'))
      await this.interrupt().catch(() => {})
      await this.operation?.catch(() => {})
      const failures: unknown[] = []
      try { await this.service.dispose() } catch (error) { failures.push(error) }
      if (!this.identity) {
        try { await this.currentEngine.dispose() } catch (error) { failures.push(error) }
      }
      if (this.pendingPromptHook) {
        try { await settleWithin(this.pendingPromptHook.catch(() => undefined), this.options.finalizationGraceMs ?? 3000) } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Session disposal left unfinished resources')
    })()
    return this.disposal
  }

  private async switchTo(sessionDir: string, seed?: readonly OpenAIMessage[]): Promise<OpenAIMessage[]> {
    this.assertOpen()
    const directory = realpathSync(resolve(sessionDir))
    if (this.samePath(directory, this.directory) && this.identity) return this.getHistory()
    const engine = this.createEngine(directory)
    let nextId: string | undefined
    try {
      const registered = await this.service.register({ sessionDir: directory, cwd: this.options.cwd, engine })
      nextId = registered.threadId
      if (seed?.length) await this.service.replaceHistory(nextId, seed)
      if (this.identity) await this.service.release(this.identity)
      else await this.currentEngine.dispose()
      this.identity = nextId
      this.currentEngine = engine
      this.directory = directory
      this.ready = Promise.resolve()
      await this.refresh()
      return this.getHistory()
    } catch (error) {
      if (nextId && nextId !== this.identity) await this.service.release(nextId)
      else if (engine !== this.currentEngine) await engine.dispose()
      throw error
    }
  }

  private createEngine(sessionDir: string): ExecutionEngine {
    return new ExecutionEngine(bindEngineSession(this.currentEngine.getConfig(), sessionDir), this.options.observer)
  }

  private async refresh(): Promise<void> {
    this.history = [...await this.service.getHistory(this.identity!)]
    this.modelWindow = [...await this.service.getModelWindow(this.identity!)]
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new AgentServiceError('client_disposed', 'Session client is disposed'))
    if (this.operation) return Promise.reject(new AgentServiceError('client_busy', 'Session has an active client operation'))
    if (this.pendingPromptHook) return Promise.reject(new AgentServiceError('prompt_hook_active', 'A cancelled prompt hook has not finished; workspace remains unavailable'))
    const operation = Promise.resolve().then(work)
    this.operation = operation
    void operation.finally(() => { if (this.operation === operation) this.operation = undefined }).catch(() => {})
    return operation
  }

  private assertOpen(): void {
    if (this.disposed) throw new AgentServiceError('client_disposed', 'Session client is disposed')
  }

  private samePath(left: string, right: string): boolean {
    return process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right)
  }

  private async deliver(event: AgentEvent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    let abort!: () => void
    try {
      await Promise.race([
        Promise.resolve().then(() => this.options.onEvent!(event)),
        new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Event delivery cancelled', { cause: signal.reason })); signal.addEventListener('abort', abort, { once: true }) }),
      ])
    } finally { signal.removeEventListener('abort', abort) }
  }

  private async submitPrompt(submit: (signal: AbortSignal) => unknown): Promise<void> {
    const controller = new AbortController()
    this.promptController = controller
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted()
      return submit(controller.signal)
    })
    this.pendingPromptHook = pending
    const settled = (): void => {
      if (this.pendingPromptHook === pending) {
        this.pendingPromptHook = undefined
        this.promptController = undefined
      }
    }
    void pending.then(settled, settled)
    let abort!: () => void
    try {
      await Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(controller.signal.reason instanceof Error ? controller.signal.reason : new DOMException('Turn cancelled before model start', 'AbortError'))
          controller.signal.addEventListener('abort', abort, { once: true })
        }),
      ])
      controller.signal.throwIfAborted()
    } finally { controller.signal.removeEventListener('abort', abort) }
  }
}
