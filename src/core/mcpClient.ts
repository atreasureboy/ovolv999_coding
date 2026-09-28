/**
 * McpStdioClient — minimal MCP (Model Context Protocol) stdio client.
 *
 * Implements just enough of the MCP spec to connect to a stdio server,
 * list its tools, and invoke them. Transport is newline-delimited
 * JSON-RPC 2.0 over the server process's stdin/stdout.
 *
 * Scope (v1): stdio transport + tools + resources + prompts protocol.
 *   NOT implemented: sampling, SSE/HTTP transport.
 * The interface is intentionally narrow so a future iteration can swap in
 * the official @modelcontextprotocol/sdk without touching call sites.
 */

import { spawn, type ChildProcess } from 'child_process'

export interface McpServerConfig {
  /** Logical name; used to namespace tool names (mcp__<name>__<tool>) */
  name: string
  /** Transport type. v1 only supports 'stdio'. */
  type: 'stdio'
  /** Command vector: command[0] is the executable, rest are args. */
  command: string[]
  /** Optional env overrides merged onto process.env. */
  env?: Record<string, string>
  /** Optional working directory for the server process. */
  cwd?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  /** JSON Schema describing the tool's arguments. */
  inputSchema: unknown
}

export interface McpResourceInfo {
  uri: string
  name?: string
  description?: string
  mimeType?: string
}

export interface McpResourceContent {
  uri: string
  mimeType?: string
  text?: string
  blob?: string
}

export interface McpPromptInfo {
  name: string
  description?: string
  arguments?: Array<{ name: string; description?: string; required?: boolean }>
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

const PROTOCOL_VERSION = '2024-11-05'
const DEFAULT_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 60_000

export class McpStdioClient {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, PendingRequest>()
  private stdoutBuf = ''
  private stderrBuf = ''
  private closed = false
  private connecting?: Promise<void>
  private closing?: Promise<void>

  constructor(private readonly server: McpServerConfig) {}

  get isClosed(): boolean {
    return this.closed
  }

  /** Spawn the server and run the MCP initialize handshake. */
  connect(signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error('MCP client closed'))
    if (!this.connecting) this.connecting = this.initialize(signal)
    return this.connecting
  }

  private async initialize(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.server.type !== 'stdio') throw new Error('Only stdio MCP transport is configured by this client')
    if (this.server.command.length === 0) {
      throw new Error(`MCP server "${this.server.name}": empty command`)
    }

    const env = { ...process.env, ...(this.server.env ?? {}) }
    this.proc = spawn(this.server.command[0], this.server.command.slice(1), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      cwd: this.server.cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
    })

    this.proc.stdout?.setEncoding('utf8')
    this.proc.stderr?.setEncoding('utf8')
    this.proc.stdin?.on('error', error => this.failAll(error))

    this.proc.stdout?.on('data', (chunk: string) => this.onStdout(chunk))
    this.proc.stderr?.on('data', (chunk: string) => {
      this.stderrBuf += chunk
      if (this.stderrBuf.length > 8192) this.stderrBuf = this.stderrBuf.slice(-8192)
    })

    this.proc.on('exit', (code, signal) => {
      this.closed = true
      const err = new Error(
        `MCP server "${this.server.name}" exited (code=${code} signal=${signal})`,
      )
      this.failAll(err)
    })
    this.proc.on('error', (err) => { this.closed = true; this.failAll(err) })

    // Initialize handshake
    await this.request(
      {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'ovolv999', version: '0.1.0' },
        },
      },
      INITIALIZE_TIMEOUT_MS,
      signal,
    ).catch(async error => { await this.close(); throw error })

    // Notify initialized (no id, no response expected)
    this.notify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  /** List tools exposed by the server. */
  async listTools(signal?: AbortSignal): Promise<McpToolInfo[]> {
    const result = (await this.request({
      jsonrpc: '2.0',
      method: 'tools/list',
    }, DEFAULT_TIMEOUT_MS, signal)) as { tools?: unknown } | null
    const tools = (result?.tools ?? []) as unknown[]
    return tools
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
      .map((t) => ({
        name: typeof t.name === 'string' ? t.name : '',
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
      }))
      .filter((t) => t.name.length > 0)
  }

  /** Invoke a tool by name. Returns concatenated text content + isError flag. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const result = (await this.request({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
    }, DEFAULT_TIMEOUT_MS, signal).catch(async error => { await this.close(); throw error })) as { content?: unknown; isError?: boolean } | null

    const rawContent = result?.content
    const contentArr: unknown[] = Array.isArray(rawContent) ? rawContent : []
    const text = contentArr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => (typeof c.text === 'string' ? c.text : ''))
      .filter((t) => t.length > 0)
      .join('\n')

    return { content: text, isError: result?.isError === true }
  }

  /** List resources exposed by the server. */
  async listResources(): Promise<McpResourceInfo[]> {
    try {
      const result = (await this.request({
        jsonrpc: '2.0',
        method: 'resources/list',
      })) as { resources?: unknown } | null
      const resources = (result?.resources ?? []) as unknown[]
      return resources
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map((r) => ({
          uri: typeof r.uri === 'string' ? r.uri : '',
          name: typeof r.name === 'string' ? r.name : undefined,
          description: typeof r.description === 'string' ? r.description : undefined,
          mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
        }))
        .filter((r) => r.uri.length > 0)
    } catch {
      return []
    }
  }

  /** Read a resource by URI. */
  async readResource(uri: string): Promise<McpResourceContent[]> {
    const result = (await this.request({
      jsonrpc: '2.0',
      method: 'resources/read',
      params: { uri },
    })) as { contents?: unknown } | null

    const rawContents = result?.contents
    const arr: unknown[] = Array.isArray(rawContents) ? rawContents : []
    return arr
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({
        uri: typeof c.uri === 'string' ? c.uri : uri,
        mimeType: typeof c.mimeType === 'string' ? c.mimeType : undefined,
        text: typeof c.text === 'string' ? c.text : undefined,
        blob: typeof c.blob === 'string' ? c.blob : undefined,
      }))
  }

  /** List prompts exposed by the server. */
  async listPrompts(): Promise<McpPromptInfo[]> {
    try {
      const result = (await this.request({
        jsonrpc: '2.0',
        method: 'prompts/list',
      })) as { prompts?: unknown } | null
      const prompts = (result?.prompts ?? []) as unknown[]
      return prompts
        .filter((p): p is Record<string, unknown> => typeof p === 'object' && p !== null)
        .map((p) => ({
          name: typeof p.name === 'string' ? p.name : '',
          description: typeof p.description === 'string' ? p.description : undefined,
          arguments: Array.isArray(p.arguments) ? (p.arguments as Array<{ name: string; description?: string; required?: boolean }>) : undefined,
        }))
        .filter((p) => p.name.length > 0)
    } catch {
      return []
    }
  }

  /** Tear down the connection. Idempotent. Returns a resolved promise for ergonomic chaining. */
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.failAll(new Error('MCP client closed'))
    const proc = this.proc
    this.proc = null
    this.closing = !proc || proc.pid === undefined || proc.exitCode !== null || proc.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((resolve, reject) => {
        let settled = false
        const terminate = (force: boolean) => {
          if (!proc.pid) return
          try {
            if (process.platform === 'win32') {
              const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
              killer.on('error', () => { try { proc.kill('SIGKILL') } catch (error) { void error } })
            } else {
              process.kill(-proc.pid, force ? 'SIGKILL' : 'SIGTERM')
            }
          } catch { try { proc.kill(force ? 'SIGKILL' : 'SIGTERM') } catch (error) { void error } }
        }
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(forceTimer)
          clearTimeout(deadline)
          proc.removeListener('exit', exited)
          proc.removeListener('error', errored)
          if (error) reject(error)
          else resolve()
        }
        const exited = () => finish()
        const errored = () => finish()
        const forceTimer = setTimeout(() => terminate(true), 500)
        const deadline = setTimeout(() => finish(new Error('MCP server shutdown was not confirmed')), 2_000)
        proc.once('exit', exited)
        proc.once('error', errored)
        try { proc.stdin?.end() } catch (error) { void error }
        terminate(false)
      })
    return this.closing
  }

  // ── internals ───────────────────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk
    let nl = this.stdoutBuf.indexOf('\n')
    while (nl !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim()
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1)
      nl = this.stdoutBuf.indexOf('\n')
      if (line.length === 0) continue
      this.handleMessage(line)
    }
  }

  private handleMessage(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      // Not valid JSON — ignore (some servers emit human logs on stdout by mistake)
      return
    }
    // Response to a request we sent
    if (typeof msg.id === 'number') {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      clearTimeout(pending.timer)
      pending.cleanup()
      this.pending.delete(msg.id)
      if (msg.error !== undefined) {
        const e = msg.error as Record<string, unknown>
        const errMsg = typeof e.message === 'string' ? e.message : JSON.stringify(msg.error)
        pending.reject(new Error(`MCP error: ${errMsg}`))
      } else {
        pending.resolve(msg.result)
      }
    }
    // Notifications / server-initiated messages: ignored in v1.
  }

  private send(message: object): void {
    if (!this.proc?.stdin || this.closed) {
      throw new Error(`MCP server "${this.server.name}": not connected`)
    }
    this.proc.stdin.write(JSON.stringify(message) + '\n')
  }

  private notify(message: object): void {
    this.send(message)
  }

  private request(message: object, timeoutMs = DEFAULT_TIMEOUT_MS, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc || this.closed) {
        reject(new Error(`MCP server "${this.server.name}": not connected`))
        return
      }
      if (signal?.aborted) { reject(new Error('MCP request cancelled')); return }
      const id = this.nextId++
      const abort = () => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        pending.cleanup()
        this.pending.delete(id)
        reject(new Error('MCP request cancelled'))
      }
      const cleanup = () => signal?.removeEventListener('abort', abort)
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          cleanup()
          reject(new Error(`MCP request id=${id} timed out after ${timeoutMs}ms (${this.server.name})`))
        }
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({ jsonrpc: '2.0', id, ...message })
      } catch (err) {
        clearTimeout(timer)
        cleanup()
        this.pending.delete(id)
        reject(err instanceof Error ? err : new Error('MCP send failed'))
      }
    })
  }

  private failAll(err: Error): void {
    if (this.closed && this.pending.size === 0) return
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.cleanup()
      p.reject(err)
    }
    this.pending.clear()
  }
}
