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

export const RPC_ERRORS = {
  PARSE_ERROR:      { code: -32700, message: 'Parse error' },
  INVALID_REQUEST:  { code: -32600, message: 'Invalid request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS:   { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR:   { code: -32603, message: 'Internal error' },
} as const

export const ACP_VERSION = '0.1.0'
export const PROTOCOL_VERSION = '2025-07-20'

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
  if (typeof o.method === 'string' && o.method.length > 0) return true
  if ('result' in o || 'error' in o) return true
  return false
}

export function serializeMessage(msg: JsonRpcMessage): string {
  return JSON.stringify(msg)
}

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
