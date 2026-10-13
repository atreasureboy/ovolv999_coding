/**
 * InkRenderer — drop-in replacement for Renderer that pushes events into a
 * UIStore instead of writing ANSI codes to stdout.
 *
 * The engine and modules call renderer methods (banner, streamToken, toolStart,
 * etc.). With Ink, these calls become React state updates that trigger
 * re-renders of the component tree.
 *
 * The method signatures match Renderer exactly so this can be swapped in
 * without touching the engine. Methods that are purely visual (writePrompt,
 * writeInterruptPrompt) are no-ops — Ink components handle their own layout.
 */

import type { UIStore } from './store.js'
import type { AgentEvent } from '../../core/agentEvents.js'

const VERBS = [
  'Thinking', 'Analyzing', 'Processing', 'Computing',
  'Reasoning', 'Working', 'Exploring', 'Building',
  'Searching', 'Drafting',
]

export class InkRenderer {
  private store: UIStore
  private eventItems = new Map<string, { id?: number; role?: 'user' | 'assistant'; text: string; displayText?: string }>()
  private eventThread?: string
  private eventSequence = 0
  private userPrompt?: string

  constructor(store: UIStore) {
    this.store = store
  }

  setUserPrompt(text: string): void {
    this.userPrompt = text
  }

  agentEvent(event: AgentEvent): void {
    if (this.eventThread !== event.threadId) {
      this.eventThread = event.threadId
      this.eventSequence = 0
      this.eventItems.clear()
    }
    if (event.sequence <= this.eventSequence) return
    this.eventSequence = event.sequence
    if (event.type === 'turn.started') {
      this.eventItems.clear()
    } else if (event.type === 'item.started') {
      if (event.kind === 'tool') {
        let input: Record<string, unknown> = { preview: event.preview ?? '' }
        try {
          const value: unknown = JSON.parse(event.preview ?? '{}')
          if (value && typeof value === 'object' && !Array.isArray(value)) input = value as Record<string, unknown>
        } catch { input = { preview: event.preview ?? '' } }
        this.eventItems.set(event.itemId, { id: this.store.addToolStart(event.name ?? 'Tool', input), text: '' })
      } else if (event.kind === 'message') {
        const displayText = event.role === 'user' && !event.expectedTurnId ? this.userPrompt : undefined
        if (displayText !== undefined) this.userPrompt = undefined
        this.eventItems.set(event.itemId, { role: event.role, text: '', displayText })
      }
    } else if (event.type === 'item.delta') {
      const item = this.eventItems.get(event.itemId)
      if (!item || event.channel === 'reasoning') return
      item.text += event.text
      if (item.role === 'assistant') this.streamToken(event.text)
    } else if (event.type === 'item.completed') {
      const item = this.eventItems.get(event.itemId)
      if (!item) return
      const text = typeof event.result === 'string' ? event.result : event.result.content
      if (item.id !== undefined) {
        this.store.setToolResult(item.id, text, typeof event.result === 'string' ? event.status !== 'completed' : event.result.isError || event.status !== 'completed')
      } else if (item.role === 'assistant') {
        if (!item.text && text) this.streamToken(text)
        this.endAssistantText()
      } else if (item.role === 'user') {
        this.store.addUserMessage(item.displayText ?? (item.text || text))
      }
      this.eventItems.delete(event.itemId)
    } else if (event.type === 'turn.finished') {
      this.endAssistantText()
      this.eventItems.clear()
      this.userPrompt = undefined
      this.stopSpinner()
    }
  }

  // ── Banner ────────────────────────────────────────────────────────────────

  banner(version: string, model: string): void {
    this.store.setBanner(version, model)
  }

  // ── User message ──────────────────────────────────────────────────────────

  humanPrompt(_text: string): void {
    // The App component adds user messages on submit, so this is a no-op.
    // Kept for interface compatibility with modules that might call it.
  }

  // ── LLM streaming ─────────────────────────────────────────────────────────

  beginAssistantText(): void {
    // No explicit action — streaming tokens are accumulated via appendStreamingToken
  }

  streamToken(token: string): void {
    this.store.setSpinner(false)
    this.store.appendStreamingToken(token)
  }

  streamReasoning(token: string): void {
    this.store.appendStreamingReasoning(token)
  }

  endAssistantText(): void {
    this.store.flushStreamingText()
  }

  // ── Tool calls ────────────────────────────────────────────────────────────

  toolStart(name: string, input: Record<string, unknown>): void {
    this.store.addToolStart(name, input)
  }

  toolResult(name: string, result: string, isError: boolean): void {
    const msgs = this.store.getState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === 'tool' && m.name === name && m.result === undefined) {
        this.store.setToolResult(m.id, result, isError)
        return
      }
    }
  }

  // ── Spinner ───────────────────────────────────────────────────────────────

  startSpinner(verb?: string): void {
    const v = verb || VERBS[Math.floor(Math.random() * VERBS.length)]
    this.store.setSpinner(true, v)
  }

  stopSpinner(): void {
    this.store.setSpinner(false)
  }

  // ── Status messages ───────────────────────────────────────────────────────

  info(msg: string): void {
    this.store.addInfo(msg)
  }

  success(msg: string): void {
    this.store.addSuccess(msg)
  }

  error(msg: string): void {
    this.store.addError(msg)
  }

  warn(msg: string): void {
    this.store.addWarn(msg)
  }

  // ── Sub-agent ─────────────────────────────────────────────────────────────

  agentStart(desc: string, type = 'general-purpose'): void {
    this.store.addAgentStart(desc, type)
  }

  agentDone(desc: string, ok: boolean): void {
    const msgs = this.store.getState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === 'agent' && m.desc === desc && m.status === 'running') {
        this.store.setAgentDone(m.id, ok)
        return
      }
    }
  }

  agentSummary(type: string, desc: string, summary: string): void {
    const msgs = this.store.getState().messages
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (m.type === 'agent' && m.agentType === type && m.desc === desc && (m.status === 'done' || m.status === 'failed')) {
        this.store.setAgentDone(m.id, m.status === 'done', summary)
        return
      }
    }
  }

  agentHeartbeat(_type: string, _desc: string, _sec: number): void {
    // Heartbeats are handled by the Spinner component's timer — no action needed.
  }

  // ── Context / compact ─────────────────────────────────────────────────────

  compactStart(tokens: number): void {
    this.store.addCompactStart(tokens)
  }

  compactDone(orig: number, sum: number): void {
    this.store.addCompactDone(orig, sum)
  }

  contextWarning(tokens: number, max: number, pct: number): void {
    this.store.addContextWarning(tokens, max, pct)
  }

  // ── Plan mode ─────────────────────────────────────────────────────────────

  planModeStart(): void {
    this.store.setPlanMode(true)
  }

  planConfirmPrompt(): void {
    // Handled by the PermissionDialog / plan approval component in Ink
  }

  // ── Interrupt ─────────────────────────────────────────────────────────────

  writeInterruptPrompt(): void {
    this.store.setInterrupt(true)
  }

  interruptInjected(msg: string): void {
    this.store.setInterrupt(true, msg)
  }

  // ── No-ops (Ink components handle their own layout) ───────────────────────

  writePrompt(): void { /* Ink PromptInput renders its own prompt */ }
  newline(): void { /* Ink Box handles spacing */ }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  destroy(): void {
    this.store.setSpinner(false)
  }
}
