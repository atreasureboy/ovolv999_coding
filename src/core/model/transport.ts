import { abortable, AdapterError, providerEndpoint } from './common.js'
import type { AdapterOptions, ModelProtocol } from './types.js'

function retryDelay(response: Response): number | undefined {
  const value = response.headers.get('retry-after')
  if (!value) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(value) - Date.now())
  return Number.isFinite(delay) && delay >= 0 && delay <= Number.MAX_SAFE_INTEGER ? delay : undefined
}

async function httpError(response: Response, signal: AbortSignal): Promise<AdapterError> {
  let contextExceeded = false
  const reader = response.body?.getReader()
  if (reader) {
    const chunks: Uint8Array[] = []
    let bytes = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Provider error body deadline exceeded')), 250) })
    try {
      for (;;) {
        const chunk = await Promise.race([abortable(reader.read(), signal), timeout])
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 16384) break
        chunks.push(chunk.value)
        try {
          const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if (value && typeof value === 'object') {
            const raw = (value as { error?: unknown }).error ?? value
            if (raw && typeof raw === 'object') {
              const error = raw as { code?: unknown; type?: unknown; message?: unknown }
              const details = [error.code, error.type, error.message].filter(value => typeof value === 'string').join(' ')
              contextExceeded = /context_length_exceeded|context_window_exceeded|maximum context length|context (?:length|window).{0,40}(?:exceed|too (?:long|large))|context too (?:long|large)|prompt is too long|input is too long|too many tokens/i.test(details)
            }
          }
          break
        } catch { continue }
      }
    } catch { contextExceeded = false } finally {
      clearTimeout(timer)
      void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
  signal.throwIfAborted()
  return new AdapterError(contextExceeded ? 'context_length_exceeded' : `http_${response.status}`, contextExceeded ? `Model maximum context length exceeded (HTTP ${response.status})` : `Model request failed (HTTP ${response.status})`, !contextExceeded && (response.status === 408 || response.status === 429 || response.status >= 500), retryDelay(response))
}

export async function* httpEvents(protocol: ModelProtocol, body: Record<string, unknown>, options: AdapterOptions, signal: AbortSignal): AsyncGenerator<unknown> {
  signal.throwIfAborted()
  const endpoint = providerEndpoint(protocol, options)
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream', ...(protocol === 'anthropic' ? { 'x-api-key': options.apiKey ?? '', 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${options.apiKey ?? ''}` }) }
  const response = await abortable((options.fetch ?? fetch)(`${endpoint}/${protocol === 'chat-completions' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages'}`, { method: 'POST', headers, body: JSON.stringify(body), signal }), signal)
  if (!response.ok) throw await httpError(response, signal)
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
