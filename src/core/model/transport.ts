import { abortable, AdapterError, providerEndpoint } from './common.js'
import type { AdapterOptions, ModelProtocol } from './types.js'

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(value) - Date.now())
  return Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER ? delay : undefined
}

export async function* httpEvents(protocol: ModelProtocol, body: Record<string, unknown>, options: AdapterOptions, signal: AbortSignal): AsyncGenerator<unknown> {
  signal.throwIfAborted()
  const endpoint = providerEndpoint(protocol, options)
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...(protocol === 'anthropic' ? { 'x-api-key': options.apiKey ?? '', 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${options.apiKey ?? ''}` }) }
  const response = await abortable((options.fetch ?? fetch)(`${endpoint}/${protocol === 'chat-completions' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages'}`, { method: 'POST', headers, body: JSON.stringify(body), signal }), signal)
  if (!response.ok) { await response.body?.cancel(); throw new AdapterError(`http_${response.status}`, `Model request failed (HTTP ${response.status})`, response.status === 408 || response.status === 429 || response.status >= 500, retryDelay(response)) }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) { await response.body?.cancel(); throw new AdapterError('invalid_stream', 'Expected a server-sent event response') }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = ''
  let data: string[] = []
  let frameBytes = 0
  let eof = false
  try {
    while (!eof) {
      const chunk = await abortable(reader.read(), signal)
      eof = chunk.done
      try { buffer += eof ? decoder.decode() : decoder.decode(chunk.value, { stream: true }) } catch { throw new AdapterError('invalid_stream', 'Malformed provider event UTF-8') }
      if (Buffer.byteLength(buffer) + frameBytes > 2 * 1024 * 1024) throw new AdapterError('invalid_stream', 'Provider event exceeds frame capacity')
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer)
        if (!match || (!eof && match[0] === '\r' && match.index === buffer.length - 1)) break
        const line = buffer.slice(0, match.index)
        buffer = buffer.slice(match.index + match[0].length)
        if (!line) {
          if (data.length) {
            const payload = data.join('\n')
            data = []; frameBytes = 0
            if (payload === '[DONE]') return
            let event: unknown
            try { event = JSON.parse(payload) as unknown } catch { throw new AdapterError('invalid_stream', 'Malformed provider event JSON') }
            signal.throwIfAborted()
            yield event
          }
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          data.push(value); frameBytes += Buffer.byteLength(value)
          if (frameBytes > 1024 * 1024) throw new AdapterError('invalid_stream', 'Provider event exceeds frame capacity')
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
