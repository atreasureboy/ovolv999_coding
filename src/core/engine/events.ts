import type { AgentEventInput, EngineEventSink } from '../agentEvents.js'
import type { OutcomeStatus, VerificationEvidence } from '../outcome.js'
import type { ToolResult } from '../types.js'

export function eventText(text: string, maxBytes = 32 * 1024): { text: string; truncated: boolean } {
  let result = '', bytes = 2
  for (const character of text) {
    const code = character.charCodeAt(0)
    const size = character === '"' || character === '\\' || '\b\t\n\f\r'.includes(character)
      ? 2
      : code < 0x20 || (character.length === 1 && code >= 0xd800 && code <= 0xdfff)
        ? 6
        : Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return { text: result, truncated: result.length < text.length }
}

export function eventVerification(value: VerificationEvidence): { verification: VerificationEvidence; truncated: boolean } {
  if (Buffer.byteLength(JSON.stringify(value)) <= 24 * 1024) return { verification: value, truncated: false }
  const resources = (values: string[]) => values.slice(0, 8).map(value => eventText(value, 128).text)
  const verification: VerificationEvidence = {
    ...value,
    workspace: eventText(value.workspace, 1024).text,
    output: eventText(value.output, 4096).text,
    ...(value.artifactVersion ? { artifactVersion: eventText(value.artifactVersion, 256).text } : {}),
    ...(value.definitionHash ? { definitionHash: eventText(value.definitionHash, 256).text } : {}),
    ...(value.runId ? { runId: eventText(value.runId, 256).text } : {}),
    ...(value.unfinishedResources ? { unfinishedResources: resources(value.unfinishedResources) } : {}),
    commands: [],
  }
  for (const command of value.commands) {
    verification.commands.push({
      ...command,
      command: eventText(command.command, 512).text,
      output: eventText(command.output, 1024).text,
      ...(command.scope ? { scope: eventText(command.scope, 256).text } : {}),
      ...(command.unfinishedResources ? { unfinishedResources: resources(command.unfinishedResources) } : {}),
    })
    if (Buffer.byteLength(JSON.stringify(verification)) > 24 * 1024) { verification.commands.pop(); break }
  }
  return { verification, truncated: true }
}

export class TurnEvents {
  private failure: unknown
  private failed = false
  constructor(readonly turnId: string, private readonly sink?: EngineEventSink) {}
  emit(event: AgentEventInput): void {
    this.check()
    if (!this.sink) return
    try { this.sink.emit(event) } catch (error) { this.failed = true; this.failure = error; throw error }
  }
  check(): void { if (this.failed) throw this.failure }
  text(itemId: string, text: string): void {
    if (!this.sink) return
    let remaining = text
    while (remaining) {
      const chunk = eventText(remaining, 16 * 1024).text
      this.emit({ type: 'item.delta', turnId: this.turnId, itemId, text: chunk })
      remaining = remaining.slice(chunk.length)
    }
  }
  message(itemId: string, text: string, role: 'user' | 'assistant', expectedTurnId?: string): void {
    this.emit({ type: 'item.started', turnId: this.turnId, itemId, kind: 'message', role, ...(expectedTurnId ? { expectedTurnId } : {}) })
    this.text(itemId, text)
    this.complete(itemId, 'message', text, 'completed')
  }
  complete(itemId: string, kind: 'message' | 'tool' | 'verification', result: string | ToolResult, status: OutcomeStatus | 'partial', verification?: VerificationEvidence): void {
    const bounded = eventText(typeof result === 'string' ? result : result.content)
    const evidence = verification ? eventVerification(verification) : undefined
    const toolEvidence = typeof result !== 'string' && result.verification ? eventVerification(result.verification) : undefined
    const workspace = typeof result !== 'string' && result.workspace
      ? { ...Object.fromEntries(Object.entries(result.workspace).filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([key, value]) => [key, eventText(value, 1024).text])), cwd: eventText(result.workspace.cwd, 1024).text }
      : undefined
    const truncated = bounded.truncated || evidence?.truncated || toolEvidence?.truncated || (workspace && typeof result !== 'string' && JSON.stringify(workspace) !== JSON.stringify(result.workspace))
    this.emit({ type: 'item.completed', turnId: this.turnId, itemId, kind, result: typeof result === 'string' ? bounded.text : { ...result, content: bounded.text, ...(toolEvidence ? { verification: toolEvidence.verification } : {}), ...(workspace ? { workspace } : {}) }, status, ...(evidence ? { verification: evidence.verification } : {}), ...(truncated ? { truncated: true } : {}) })
  }
}
