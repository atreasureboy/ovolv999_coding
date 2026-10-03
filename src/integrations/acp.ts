import { EventEmitter } from 'events'
import { attachFramedInput } from './acp/framing.js'
import { ACP_VERSION, PROTOCOL_VERSION, RPC_ERRORS, errorResponse, notification, okResponse, parseMessage, serializeMessage } from './acp/protocol.js'
import type { ACPCapabilities, ACPHandlers, JsonRpcMessage } from './acp/protocol.js'

export { ACP_VERSION, PROTOCOL_VERSION, RPC_ERRORS, errorResponse, notification, okResponse, parseMessage, serializeMessage } from './acp/protocol.js'
export type { ACPCapabilities, ACPHandlers, JsonRpcMessage, JsonRpcNotification, JsonRpcRequest, JsonRpcResponse } from './acp/protocol.js'

const METHOD_TRAITS = new Map<string, { exclusive: boolean }>([
  ['message', { exclusive: true }],
  ['interrupt', { exclusive: false }],
  ['file/read', { exclusive: true }],
  ['file/write', { exclusive: true }],
  ['cost', { exclusive: false }],
])

export class ACPServer extends EventEmitter {
  private handlers: ACPHandlers
  private cwd: string
  private initialized = false
  private shutdownRequested = false
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

  getCapabilities(): ACPCapabilities {
    return {
      streaming: false,
      tools: Boolean(this.handlers.onMessage && this.advertised.tools),
      multiModal: Boolean(this.handlers.onMessage),
      worktrees: Boolean(this.handlers.onMessage && this.advertised.worktrees),
      interrupts: Boolean(this.handlers.onInterrupt),
    }
  }

  start(input: NodeJS.ReadableStream = process.stdin): void {
    this.detachInput?.()
    this.shutdownRequested = false
    const failed = (error: Error): void => { this.emit('protocolError', error); this.stop() }
    this.detachInput = attachFramedInput(input, this.maxMessageBytes, {
      onFrame: line => {
        const message = parseMessage(line)
        if (!message) { this.send(errorResponse(undefined, RPC_ERRORS.PARSE_ERROR.code, 'Invalid JSON-RPC frame')); return }
        void this.handleMessage(message).catch(failed)
      },
      onError: failed,
      onClose: () => { this.stop(); this.emit('close') },
    })
  }

  stop(): void {
    this.detachInput?.()
    this.detachInput = undefined
    this.initialized = false
  }

  send(msg: JsonRpcMessage): void {
    const text = serializeMessage(msg)
    if (Buffer.byteLength(text) > this.maxMessageBytes) {
      this.writeFn(serializeMessage(errorResponse('id' in msg ? msg.id : undefined, RPC_ERRORS.INTERNAL_ERROR.code, 'ACP response byte limit exceeded')) + '\n')
      return
    }
    this.writeFn(text + '\n')
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.send(notification(method, params))
  }

  async handleMessage(msg: JsonRpcMessage): Promise<void> {
    if (!('method' in msg)) return

    const req = msg
    const id = 'id' in req ? req.id : undefined
    const { method, params } = req
    if (this.shutdownRequested) { this.respondError(id, RPC_ERRORS.INVALID_REQUEST.code, 'Server has shut down'); return }
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) { this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Invalid params'); return }
    if (Buffer.byteLength(JSON.stringify(req)) > this.maxMessageBytes) { this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'ACP request byte limit exceeded'); return }
    const traits = METHOD_TRAITS.get(method)
    if (traits && !this.initialized) { this.respondError(id, RPC_ERRORS.INVALID_REQUEST.code, 'Server not initialized'); return }
    const exclusive = traits?.exclusive ?? false
    if (exclusive && this.active) { this.respondError(id, -32000, 'Execution owner is busy'); return }
    if (exclusive) this.active++

    try {
      switch (method) {
        case 'initialize':
          if (params?.protocolVersion !== undefined && params.protocolVersion !== PROTOCOL_VERSION) { this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Unsupported protocol version'); break }
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
          this.shutdownRequested = true
          this.stop()
          this.respond(id, {})
          this.emit('shutdown')
          break

        case 'message':
          await this.handleMessageMethod(id, params)
          break

        case 'interrupt':
          if (!this.handlers.onInterrupt) { this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'Interrupt handler is not configured'); break }
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
    if (!this.handlers.onMessage) {
      this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'No message handler')
      return
    }

    const text = params?.text
    const images = params?.images

    if (typeof text !== 'string' || !text || (images !== undefined && (!Array.isArray(images) || !images.every(image => typeof image === 'string')))) {
      this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "text" param')
      return
    }

    try {
      this.notify('message/received', { text })

      const response = await this.handlers.onMessage(text, images)

      this.respond(id, { text: response, done: true })

      this.notify('response', { text: response, done: true })
    } catch (err) {
      this.respondError(id, RPC_ERRORS.INTERNAL_ERROR.code, (err as Error).message)
    }
  }

  private async handleFileRead(id: string | number | undefined, params?: Record<string, unknown>): Promise<void> {
    const path = params?.path
    if (typeof path !== 'string' || !path) { this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Missing "path"'); return }
    if (!this.handlers.onFileRead) { this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'File reading is not configured'); return }
    const content = await this.handlers.onFileRead(path)
    this.respond(id, { path, content })
  }

  private async handleFileWrite(id: string | number | undefined, params?: Record<string, unknown>): Promise<void> {
    const path = params?.path
    const content = params?.content
    if (typeof path !== 'string' || !path || typeof content !== 'string') { this.respondError(id, RPC_ERRORS.INVALID_PARAMS.code, 'Valid path and content strings are required'); return }
    if (!this.handlers.onFileWrite) { this.respondError(id, RPC_ERRORS.METHOD_NOT_FOUND.code, 'File writing is not configured'); return }
    await this.handlers.onFileWrite(path, content)
    this.respond(id, { path, written: true })
  }

  private respond(id: string | number | undefined, result: unknown): void {
    if (id === undefined) return
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
