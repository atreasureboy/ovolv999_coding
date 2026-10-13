import type { AgentEvent } from '../../core/agentEvents.js'
import { AgentServiceError } from '../../core/agentService.js'
import type { AgentSessionClient } from '../../core/agentSessionClient.js'
import { resolveModelRuntime } from '../../core/modelRuntime.js'
import type { ACPCapabilities, ACPHandlers, ACPMessageResult } from './protocol.js'

export class ACPAgentAdapter {
  readonly handlers: ACPHandlers
  readonly capabilities: Partial<ACPCapabilities>
  private terminal?: Extract<AgentEvent, { type: 'turn.finished' }>
  private pending?: Promise<ACPMessageResult>

  constructor(private readonly options: {
    client: AgentSessionClient
    emit: (event: AgentEvent) => Promise<void>
    onUserPromptSubmit?: (text: string, signal?: AbortSignal) => Promise<unknown>
  }) {
    const capabilities = resolveModelRuntime(options.client.engine.getConfig()).options.capabilities
    this.capabilities = { streaming: true, tools: capabilities.tools, multiModal: capabilities.vision, worktrees: false }
    this.handlers = {
      onMessage: (text, images) => {
        const pending = this.message(text, images)
        this.pending = pending
        void pending.then(() => { if (this.pending === pending) this.pending = undefined }, () => { if (this.pending === pending) this.pending = undefined })
        return pending
      },
      onInterrupt: async expectedTurnId => {
        const activeTurnId = this.options.client.activeTurnId
        if (expectedTurnId !== undefined && expectedTurnId !== activeTurnId) return false
        if (!activeTurnId && !this.pending) return false
        try { await this.options.client.interrupt(expectedTurnId ?? activeTurnId) } catch (error) {
          if (error instanceof AgentServiceError && error.code === 'stale_turn') return false
          throw error
        }
        return true
      },
      onCost: () => {
        const tracker = this.options.client.engine.getCostTracker()
        return { inputTokens: tracker.getTotalInputTokens(), outputTokens: tracker.getTotalOutputTokens(), totalCost: tracker.getTotalCost() }
      },
    }
  }

  async publish(event: AgentEvent): Promise<void> {
    if (event.type === 'turn.finished') this.terminal = event
    await this.options.emit(event)
  }

  async drain(): Promise<void> {
    await this.pending?.catch(() => undefined)
  }

  private async message(text: string, images?: string[]): Promise<ACPMessageResult> {
    if (!text.trim()) throw new Error('Message text must be non-empty')
    if (images?.length && !this.capabilities.multiModal) throw new Error('Configured model does not support image input')
    const inputs = images?.map((image, index) => {
      const match = /^data:image\/(?:png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
      if (!match || Buffer.from(match[1], 'base64').toString('base64') !== match[1]) throw new Error('ACP images must be base64 PNG, JPEG, WebP, or GIF data URLs')
      return { path: 'acp-image-' + index, dataUrl: image }
    })
    this.terminal = undefined
    const outcome = await this.options.client.runTurn(text, inputs, this.options.onUserPromptSubmit ? signal => this.options.onUserPromptSubmit!(text, signal) : undefined)
    const terminal = this.lastTerminal()
    if (!terminal || terminal.turnId !== outcome.result.runId) throw new Error('ACP turn ended without a durable terminal event')
    return {
      text: terminal.result.output, status: terminal.status, threadId: terminal.threadId, turnId: terminal.turnId,
      ...(terminal.truncated ? { truncated: true } : {}), ...(terminal.artifact ? { artifact: terminal.artifact } : {}),
    }
  }

  private lastTerminal(): Extract<AgentEvent, { type: 'turn.finished' }> | undefined {
    return this.terminal
  }
}
