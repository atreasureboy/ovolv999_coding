/**
 * UI Store — the bridge between the imperative engine and declarative Ink/React.
 *
 * The engine calls InkRenderer methods (which match the Renderer interface).
 * InkRenderer pushes events into this store. React components subscribe via
 * useSyncExternalStore and re-render on changes.
 *
 * This decouples the engine (which knows nothing about React) from the UI
 * (which knows nothing about the engine's internal flow).
 */

import { useSyncExternalStore } from 'react'

// ── Message model ───────────────────────────────────────────────────────────

export type UIMessage =
  | { id: number; type: 'user'; text: string }
  | { id: number; type: 'assistant'; text: string }
  | {
      id: number
      type: 'tool'
      name: string
      input: Record<string, unknown>
      result?: string
      isError?: boolean
      startTime?: number
      elapsedMs?: number
    }
  | { id: number; type: 'info'; text: string }
  | { id: number; type: 'success'; text: string }
  | { id: number; type: 'warn'; text: string }
  | { id: number; type: 'error'; text: string }
  | {
      id: number
      type: 'agent'
      desc: string
      agentType: string
      status: 'running' | 'done' | 'failed'
      summary?: string
    }
  | {
      id: number
      type: 'compact'
      phase: 'start' | 'done'
      origTokens?: number
      sumTokens?: number
    }
  | { id: number; type: 'context-warning'; tokens: number; max: number; pct: number }

// ── Interactive overlay types (plan approval, permission, select picker) ─────

export interface UIPermissionRequest {
  toolName: string
  preview: string
  riskLevel: 'safe' | 'needs-approval' | 'dangerous'
}

export interface UISelectItem<T = unknown> {
  label: string
  description?: string
  value: T
}

/** Distributive Omit — properly handles the discriminated union. */
export type NewUIMessage = {
  [K in UIMessage['type']]: Omit<Extract<UIMessage, { type: K }>, 'id'>
}[UIMessage['type']]

// ── Full UI state ───────────────────────────────────────────────────────────

export interface UIState {
  messages: UIMessage[]
  /** Currently streaming assistant text (accumulated token by token). */
  streamingText: string
  /** Currently streaming reasoning/thinking text (from <think> tags). */
  streamingReasoning: string
  /** True while engine.runTurn() is in flight. */
  running: boolean
  /** Spinner state. */
  spinnerActive: boolean
  spinnerVerb: string
  /** Banner info (set once at startup). */
  banner: { version: string; model: string } | null
  /** Interrupt overlay (ESC pressed). */
  interrupt: { active: boolean; feedback?: string } | null
  /** Plan mode indicator. */
  planMode: boolean
  /** Pending plan approval (ExitPlanMode tool). */
  pendingPlan: { plan: string } | null
  /** Pending permission request (tool approval). */
  pendingPermission: UIPermissionRequest | null
  /** Pending select picker overlay. */
  selectOverlay: { title: string; items: UISelectItem[] } | null
  /** Cost tracking (updated after each turn). */
  cost: number
  apiCalls: number
  /** Verbose mode (Ctrl+O) — show all tool results expanded. */
  verbose: boolean
}

const INITIAL_STATE: UIState = {
  messages: [],
  streamingText: '',
  streamingReasoning: '',
  running: false,
  spinnerActive: false,
  spinnerVerb: '',
  banner: null,
  interrupt: null,
  planMode: false,
  pendingPlan: null,
  pendingPermission: null,
  selectOverlay: null,
  cost: 0,
  apiCalls: 0,
  verbose: false,
}

// ── Store implementation ────────────────────────────────────────────────────

export class UIStore {
  private state: UIState = { ...INITIAL_STATE, messages: [] }
  private listeners = new Set<() => void>()
  private nextId = 1
  // Resolvers for interactive overlays (kept outside state — not serializable)
  private planResolver: ((approved: boolean) => void) | null = null
  private permissionResolver:
    | ((result: { approved: boolean; alwaysAllow: boolean; feedback?: string }) => void)
    | null = null
  private selectResolver: ((value: unknown) => void) | null = null

  getState = (): UIState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private publish(patch: Partial<UIState>): void {
    this.state = { ...this.state, ...patch }
    for (const l of this.listeners) l()
  }

  // ── Mutations ─────────────────────────────────────────────────────────────

  private add(msg: NewUIMessage, patch: Partial<UIState> = {}): number {
    const id = this.nextId++
    this.publish({
      ...patch,
      messages: [...this.state.messages, { ...msg, id }],
    })
    return id
  }

  private update(id: number, transform: (message: UIMessage) => UIMessage): void {
    this.publish({
      messages: this.state.messages.map((m) => (m.id === id ? transform(m) : m)),
    })
  }

  // ── High-level operations ─────────────────────────────────────────────────

  addUserMessage(text: string): void {
    this.add({ type: 'user', text })
  }

  addAssistantMessage(text: string): void {
    this.add({ type: 'assistant', text })
  }

  /** Streaming: accumulate tokens into a temporary buffer. */
  appendStreamingToken(token: string): void {
    this.publish({ streamingText: this.state.streamingText + token })
  }

  /** Streaming: accumulate reasoning tokens (from <think> tags). */
  appendStreamingReasoning(token: string): void {
    this.publish({ streamingReasoning: this.state.streamingReasoning + token })
  }

  /** Flush accumulated streaming text as a message, then clear the buffer. */
  flushStreamingText(): void {
    const text = this.state.streamingText.trim()
    const cleared = { streamingText: '', streamingReasoning: '' }
    if (text) this.add({ type: 'assistant', text }, cleared)
    else this.publish(cleared)
  }

  addToolStart(name: string, input: Record<string, unknown>): number {
    return this.add({ type: 'tool', name, input, startTime: Date.now() })
  }

  setToolResult(id: number, result: string, isError: boolean): void {
    this.update(id, (message) => {
      if (message.type !== 'tool') return message
      const elapsedMs = message.startTime === undefined ? undefined : Date.now() - message.startTime
      return { ...message, result, isError, elapsedMs }
    })
  }

  addInfo(text: string): void {
    this.add({ type: 'info', text })
  }
  addSuccess(text: string): void {
    this.add({ type: 'success', text })
  }
  addWarn(text: string): void {
    if (text.trim()) this.add({ type: 'warn', text })
  }
  addError(text: string): void {
    this.add({ type: 'error', text })
  }

  addAgentStart(desc: string, agentType: string): number {
    return this.add({ type: 'agent', desc, agentType, status: 'running' })
  }

  setAgentDone(id: number, ok: boolean, summary?: string): void {
    this.update(id, (message) =>
      message.type === 'agent' ? { ...message, status: ok ? 'done' : 'failed', summary } : message,
    )
  }

  addCompactStart(tokens: number): void {
    this.add({ type: 'compact', phase: 'start', origTokens: tokens })
  }

  addCompactDone(orig: number, sum: number): void {
    this.add({ type: 'compact', phase: 'done', origTokens: orig, sumTokens: sum })
  }

  addContextWarning(tokens: number, max: number, pct: number): void {
    this.add({ type: 'context-warning', tokens, max, pct })
  }

  // ── State setters ─────────────────────────────────────────────────────────

  setRunning(running: boolean): void {
    this.publish({ running })
  }

  setSpinner(active: boolean, verb = ''): void {
    this.publish({ spinnerActive: active, spinnerVerb: verb })
  }

  setBanner(version: string, model: string): void {
    this.publish({ banner: { version, model } })
  }

  setInterrupt(active: boolean, feedback?: string): void {
    this.publish({ interrupt: active ? { active, feedback } : null })
  }

  setPlanMode(active: boolean): void {
    this.publish({ planMode: active })
  }

  setCost(cost: number, apiCalls: number): void {
    this.publish({ cost, apiCalls })
  }

  setModel(model: string): void {
    this.publish({ banner: this.state.banner ? { ...this.state.banner, model } : null })
  }

  toggleVerbose(): void {
    this.publish({ verbose: !this.state.verbose })
  }

  // ── Interactive overlays (plan approval, permission, select picker) ───────
  // The resolve functions are stored privately and called by resolveX().

  showPlanApproval(plan: string): Promise<boolean> {
    this.cancelOverlays()
    return new Promise<boolean>((resolve) => {
      this.planResolver = resolve
      this.publish({ pendingPlan: { plan } })
    })
  }

  resolvePlan(approved: boolean): void {
    this.planResolver?.(approved)
    this.planResolver = null
    this.publish({ pendingPlan: null })
  }

  showPermissionDialog(
    request: UIPermissionRequest,
  ): Promise<{ approved: boolean; alwaysAllow: boolean; feedback?: string }> {
    this.cancelOverlays()
    return new Promise<{ approved: boolean; alwaysAllow: boolean; feedback?: string }>(
      (resolve) => {
        this.permissionResolver = resolve
        this.publish({ pendingPermission: request })
      },
    )
  }

  resolvePermission(approved: boolean, alwaysAllow: boolean, feedback?: string): void {
    this.permissionResolver?.({ approved, alwaysAllow, feedback })
    this.permissionResolver = null
    this.publish({ pendingPermission: null })
  }

  showSelectPicker<T>(title: string, items: UISelectItem<T>[]): Promise<T | null> {
    this.cancelOverlays()
    return new Promise<T | null>((resolve) => {
      this.selectResolver = resolve as (value: unknown) => void
      this.publish({ selectOverlay: { title, items } })
    })
  }

  resolveSelect(value: unknown): void {
    this.selectResolver?.(value)
    this.selectResolver = null
    this.publish({ selectOverlay: null })
  }

  cancelOverlays(): void {
    this.planResolver?.(false)
    this.permissionResolver?.({ approved: false, alwaysAllow: false })
    this.selectResolver?.(null)
    this.planResolver = null
    this.permissionResolver = null
    this.selectResolver = null
    if (this.hasOverlay()) {
      this.publish({ pendingPlan: null, pendingPermission: null, selectOverlay: null })
    }
  }

  /** True when any interactive overlay is blocking input. */
  hasOverlay(): boolean {
    return (
      this.state.pendingPlan !== null ||
      this.state.pendingPermission !== null ||
      this.state.selectOverlay !== null
    )
  }

  /** Clear all messages (for /clear). */
  clearMessages(): void {
    this.publish({ messages: [] })
  }

  /** Full reset (for testing). */
  reset(): void {
    this.cancelOverlays()
    this.nextId = 1
    this.publish({ ...INITIAL_STATE, messages: [] })
  }
}

// ── React hook ──────────────────────────────────────────────────────────────

export function useUIStore(store: UIStore): UIState {
  return useSyncExternalStore(store.subscribe, store.getState)
}

// ── Singleton (used by InkRenderer, set during App initialization) ──────────

let _globalStore: UIStore | null = null

export function setGlobalStore(store: UIStore): void {
  _globalStore = store
}

export function getGlobalStore(): UIStore {
  if (!_globalStore) {
    _globalStore = new UIStore()
  }
  return _globalStore
}
