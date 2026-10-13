import type { AgentEvent, AgentItemFields } from '../core/agentEvents.js'
import type { EngineObserver } from '../core/engine/observer.js'

function toolInput(preview?: string): Record<string, unknown> {
  if (!preview) return {}
  try {
    const value: unknown = JSON.parse(preview)
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  } catch { return { preview } }
  return { preview }
}

export function createAgentEventRenderer(observer: EngineObserver): (event: AgentEvent) => void {
  const items = new Map<string, AgentItemFields>()
  let streaming: string | undefined
  return event => {
    if (event.type === 'turn.started') items.clear()
    if (event.type === 'item.started') {
      items.set(event.itemId, event)
      if (event.kind === 'message' && event.role === 'assistant') {
        observer.stopSpinner()
        observer.beginAssistantText()
        streaming = event.itemId
      } else if (event.kind === 'tool') observer.toolStart(event.name ?? 'Tool', toolInput(event.preview))
    } else if (event.type === 'item.delta') {
      if (items.get(event.itemId)?.role !== 'assistant') return
      if (event.channel === 'reasoning') observer.streamReasoning?.(event.text)
      else observer.streamToken(event.text)
    } else if (event.type === 'item.completed') {
      const item = items.get(event.itemId)
      if (item?.kind === 'tool') {
        const result = event.result
        observer.toolResult(item.name ?? 'Tool', typeof result === 'string' ? result : result.content, typeof result === 'string' ? event.status !== 'completed' : result.isError)
      }
      if (streaming === event.itemId) { observer.endAssistantText(); streaming = undefined }
      items.delete(event.itemId)
    } else if (event.type === 'turn.finished') {
      if (streaming !== undefined) observer.endAssistantText()
      streaming = undefined
      items.clear()
      observer.stopSpinner()
    } else if (event.type === 'error') observer.error(event.message)
  }
}
