/**
 * ACP Server — Agent Client Protocol over stdio.
 *
 * Enables editor integration (Zed, VSCode, Neovim) by exposing the
 * ovolv999 engine as a JSON-RPC server communicating over stdin/stdout.
 *
 * Protocol (line-delimited JSON-RPC 2.0):
 *   → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{...}}
 *   ← {"jsonrpc":"2.0","id":1,"result":{"capabilities":{...}}}
 *
 *   → {"jsonrpc":"2.0","method":"message","params":{"text":"hello"}}
 *   ← {"jsonrpc":"2.0","method":"response","params":{"text":"...","done":false}}
 *   ← {"jsonrpc":"2.0","method":"response","params":{"text":"...","done":true}}
 *
 * Inspired by Claude Code's ACP implementation and the LSP specification.
 */

import { StringDecoder } from 'string_decoder'
import { EventEmitter } from 'events'

// ── Types ───────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id?: string | number
  method: string
  params?: Record<string, unknown>
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id?: string | number
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification

export interface ACPCapabilities {
  streaming: boolean
  tools: boolean
  multiModal: boolean
  worktrees: boolean
  interrupts: boolean
}

export interface ACPHandlers {
  onMessage?: (text: string, images?: string[]) => Promise<string>
  onInterrupt?: () => void
  onFileRead?: (path: string) => string | Promise<string>
  onFileWrite?: (path: string, content: string) => void | Promise<void>
  onCost?: () => { inputTokens: number; outputTokens: number; totalCost: number }
}

// ── Error Codes ─────────────────────────────────────────────────────────────

export const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
} as const

// ── Protocol Version ────────────────────────────────────────────────────────

export const ACP_VERSION = '0.1.0'
export const PROTOCOL_VERSION = '2025-07-20'

// ── Message Parsing ─────────────────────────────────────────────────────────

/**
 * Parse a single line as JSON-RPC.
 * Returns null if the line is empty or not valid JSON.
 */
export function parseMessage(line: string): JsonRpcMessage | null {
  const trimmed = line.trim()
  if (!trimmed) return null

  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (!isValidMessage(parsed)) return null
    return parsed as JsonRpcMessage
  } catch {
    return null
  }
}

function isValidMessage(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false
  const o = obj as Record<string, unknown>
  if (o.jsonrpc !== '2.0') return false
  if ('id' in o && typeof o.id !== 'string' && (typeof o.id !== 'number' || !Number.isFinite(o.id))) return false
  // Request: has method
  // Response: has result or error, and id
  // Notification: has method, no id
  if (typeof o.method === 'string' && o.method.length > 0) return true // request or notification
  if ('result' in o || 'error' in o) return true // response
  return false
}

/**
 * Serialize a message to a JSON-RPC line.
 */
export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg)
}

// ── Response Builders ───────────────────────────────────────────────────────

export function okResponse(id: string | number | undefined, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result }
}

export function errorResponse(
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, data } }
}

export function notification(method: string, params?: Record<string, unknown>): JsonRpcNotification {
  return { jsonrpc: '2.0', method, params }
}

// ── ACP Server ──────────────────────────────────────────────────────────────

export class ACPServer extends EventEmitter {
  private handlers: ACPHandlers
  private cwd: string
  private initialized = false
  private detachInput?: () => void
  private active = 0
  private maxMessageBytes: number
  private advertised: Partial<ACPCapabilities>
  private writeFn: (data: string) => void

  constructor(
    handlers: ACPHandlers,
    options: { cwd: string; write?: (data: string) => void; maxMessageBytes?: number; capabilities?: Partial<ACPCapabilities> },
  ) {
    super()
    this.handlers = handlers
    this.cwd = options.cwd
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024
    this.advertised = options.capabilities ?? {}
    this.writeFn = options.write ?? ((data: string) => process.stdout.write(data))
  }

  /** Get server capabilities */
  getCapabilities(): ACPCapabilities {
    return {
      streaming: false,
      tools: Boolean(this.handlers.onMessage && this.advertised.tools),
      multiModal: Boolean(this.handlers.onMessage),
      worktrees: Boolean(this.handlers.onMessage && this.advertised.worktrees),
      interrupts: Boolean(this.handlers.onInterrupt),
    }
  }

  /** Start listening on a readline interface (defaults to stdin) */
  start(input: NodeJS.ReadableStream = process.stdin): void {
    this.detachInput?.()
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    const failed = (error: Error): void => { this.emit('protocolError', error); this.stop() }
    const receive = (chunk: Buffer | string): void => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      for (;;) {
        const nl = buffer.indexOf('\n')
        const length = Buffer.byteLength(nl < 0 ? buffer : buffer.slice(0, nl))
        if (length > this.maxMessageBytes) { failed(new Error('ACP message byte limit exceeded')); return }
        if (nl < 0) return
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
        const message = parseMessage(line)
        if (!message) { this.send(errorResponse(undefined, -32700, 'Invalid JSON-RPC frame')); continue }
        void this.handleMessage(message).catch(failed)
      }
    }
    const closed = (): void => { this.stop(); this.emit('close') }
    input.on('data', receive)
    input.once('end', closed)
    this.detachInput = () => { input.removeListener('data', receive); input.removeListener('end', closed); buffer = '' }
  }

  stop(): void {
    this.detachInput?.()
    this.detachInput = undefined
    this.initialized = false
  }

  /** Send a message to the client */
  send(msg: JsonRpcMessage): void {
    const text = serializeMessage(msg)
    if (Buffer.byteLength(text) > this.maxMessageBytes) {
      this.writeFn(serializeMessage(errorResponse('id' in msg ? msg.id : undefined, -32603, 'ACP response byte limit exceeded')) + '\n')
      return
    }
    this.writeFn(text + '\n')
  }

  /** Send a notification (no response expected) */
  notify(method: string, params?: Record<string, unknown>): void {
    this.send(notification(method, params))
  }

  /** Handle a single JSON-RPC message */
  async handleMessage(msg: JsonRpcMessage): Promise<void> {
    // Only handle requests and notifications (not responses from client)
    if (!('method' in msg)) return

    const req = msg
    const id = 'id' in req ? req.id : undefined
    const { method, params } = req
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) { this.respondError(id, -32602, 'Invalid params'); return }
    if (Buffer.byteLength(JSON.stringify(req)) > this.maxMessageBytes) { this.respondError(id, -32602, 'ACP request byte limit exceeded'); return }
    if (['message', 'interrupt', 'file/read', 'file/write', 'cost'].includes(method) && !this.initialized) { this.respondError(id, -32600, 'Server not initialized'); return }
    const exclusive = ['message', 'file/read', 'file/write'].includes(method)
    if (exclusive && this.active) { this.respondError(id, -32000, 'Execution owner is busy'); return }
    if (exclusive) this.active++

    try {
      switch (method) {
        case 'initialize':
          if (params?.protocolVersion !== undefined && params.protocolVersion !== PROTOCOL_VERSION) { this.respondError(id, -32602, 'Unsupported protocol version'); break }
          this.initialized = true
          this.respond(id, {
            protocolVersion: PROTOCOL_VERSION,
            serverInfo: {
              name: 'ovolv999',
              version: ACP_VERSION,
            },
            capabilities: this.getCapabilities(),
            cwd: this.cwd,
          })
          break

        case 'shutdown':
          this.initialized = false
          this.respond(id, {})
          this.emit('shutdown')
          break

        case 'message':
          await this.handleMessageMethod(id, params)
          break

        case 'interrupt':
          if (!this.handlers.onInterrupt) { this.respondError(id, -32601, 'Interrupt handler is not configured'); break }
          this.handlers.onInterrupt()
          this.respond(id, { interrupted: true })
          break

        case 'file/read':
          await this.handleFileRead(id, params)
          break

        case 'file/write':
          await this.handleFileWrite(id, params)
          break

        case 'cost':
          if (this.handlers.onCost) {
            this.respond(id, this.handlers.onCost())
          } else {
            this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'Cost tracking not available')
          }
          break

        default:
          if (id !== undefined) {
            this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, `Unknown method: ${method}`)
          }
      }
    } catch (err) {
      if (id !== undefined) {
        this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, (err as Error).message)
      }
      if (this.listenerCount('error')) this.emit('error', err)
    } finally { if (exclusive) this.active-- }
  }

  private async handleMessageMethod(
    id: string | number | undefined,
    params?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.initialized) {
      this.respondError(id, RPC_ERRORS.INVALID_REQUEST.code, 'Server not initialized')
      return
    }

    if (!this.handlers.onMessage) {
      this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'No message handler')
      return
    }

    const text = typeof params?.text === 'string' ? params.text : ''
    const images = Array.isArray(params?.images) ? (params.images as string[]) : undefined

    if (!text || (params?.images !== undefined && (!Array.isArray(params.images) || !params.images.every(image => typeof image === 'string')))) {
      this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "text" param')
      return
    }

    try {
      // Notify: message received
      this.notify('message/received', { text })

      // Process the message
      const response = await this.handlers.onMessage(text, images)

      // Send response
      this.respond(id, { text: response, done: true })

      // Also notify with streaming-like event
      this.notify('response', { text: response, done: true })
    } catch (err) {
      this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, (err as Error).message)
    }
  }

  private async handleFileRead(id: string | number | undefined, params?: Record<string, unknown>): Promise<void> {
    const path = params?.path
    if (typeof path !== 'string' || !path) { this.respondError(id, -32602, 'Missing "path"'); return }
    if (!this.handlers.onFileRead) { this.respondError(id, -32601, 'File reading is not configured'); return }
    const content = await this.handlers.onFileRead(path)
    this.respond(id, { path, content })
  }

  private async handleFileWrite(id: string | number | undefined, params?: Record<string, unknown>): Promise<void> {
    const path = params?.path
    const content = params?.content
    if (typeof path !== 'string' || !path || typeof content !== 'string') { this.respondError(id, -32602, 'Valid path and content strings are required'); return }
    if (!this.handlers.onFileWrite) { this.respondError(id, -32601, 'File writing is not configured'); return }
    await this.handlers.onFileWrite(path, content)
    this.respond(id, { path, written: true })
  }

  private respond(id: string | number | undefined, result: unknown): void {
    if (id === undefined) return // notification — no response
    this.send(okResponse(id, result))
  }

  private respondError(
    id: string | number | undefined,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    if (id === undefined) return
    this.send(errorResponse(id, code, message, data))
  }
}
