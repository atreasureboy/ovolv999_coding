/**
 * In-process LSP Client
 *
 * Manages a persistent language-server process (default: TypeScript
 * tsserver) for fast, incremental diagnostics without shelling out to
 * `tsc --noEmit` on every request.
 *
 * Protocol: minimal LSP-over-stdio (JSON-RPC 2.0 with Content-Length
 * framing). We only implement the subset we need:
 *   - initialize / shutdown
 *   - textDocument/didOpen, didChange, didSave
 *   - textDocument/publishDiagnostics (notification)
 *   - workspace/symbol (for code navigation)
 *
 * If the language server binary isn't found or fails to start, all
 * operations degrade gracefully (return empty results) so the caller
 * — usually the Diagnostics tool — falls back to a tsc shellout.
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import { resolve } from 'path'
import { existsSync, readFileSync } from 'fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isRecord } from './persistedData.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type LanguageId = 'typescript' | 'javascript' | 'python' | 'rust' | 'go'

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspDiagnostic {
  uri: string
  range: LspRange
  severity: 'error' | 'warning' | 'information' | 'hint'
  code?: string | number
  source?: string
  message: string
}

export interface LspSymbol {
  name: string
  kind: number
  location: { uri: string; range: LspRange }
  containerName?: string
}

export interface LspClientOptions {
  /** Server command (default: auto-detect tsserver) */
  command?: string
  /** Server args */
  args?: string[]
  /** Workspace root */
  rootUri: string
  /** Language ID */
  languageId?: LanguageId
  /** Init timeout ms */
  timeoutMs?: number
}

interface LspMessage {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

// ── Server Detection ────────────────────────────────────────────────────────

interface ServerSpec {
  command: string
  args: string[]
  languageId: LanguageId
}

const SERVER_PATTERNS: Record<LanguageId, ServerSpec[]> = {
  typescript: [
    { command: 'typescript-language-server', args: ['--stdio'], languageId: 'typescript' },
  ],
  javascript: [
    { command: 'typescript-language-server', args: ['--stdio'], languageId: 'javascript' },
  ],
  python: [
    { command: 'pylsp', args: [], languageId: 'python' },
    { command: 'pyright-langserver', args: ['--stdio'], languageId: 'python' },
    { command: 'ruff-lsp', args: [], languageId: 'python' },
  ],
  rust: [
    { command: 'rust-analyzer', args: [], languageId: 'rust' },
  ],
  go: [
    { command: 'gopls', args: [], languageId: 'go' },
  ],
}

export function detectServer(languageId: LanguageId = 'typescript', cwd = process.cwd()): ServerSpec | null {
  const specs = SERVER_PATTERNS[languageId]
  if (!specs) return null

  if (languageId === 'typescript' || languageId === 'javascript') {
    try {
      const dir = resolve(cwd, 'node_modules', 'typescript-language-server')
      const pkg: unknown = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'))
      const bin = isRecord(pkg) && (typeof pkg.bin === 'string' ? pkg.bin : isRecord(pkg.bin) ? pkg.bin['typescript-language-server'] : undefined)
      if (typeof bin === 'string' && existsSync(resolve(dir, bin))) return { command: process.execPath, args: [resolve(dir, bin), '--stdio'], languageId }
    } catch (error) { void error }
  }

  for (const spec of specs) {
    try {
      execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [spec.command], { stdio: 'pipe', timeout: 2000, windowsHide: true })
      return spec
    } catch { /* not found */ }
  }

  return null
}

// ── LSP Client ──────────────────────────────────────────────────────────────

export class LspClient extends EventEmitter {
  private proc: ChildProcess | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private buffer: Buffer = Buffer.alloc(0)
  private initialized = false
  private diagnostics = new Map<string, LspDiagnostic[]>()
  private serverSpec: ServerSpec | null = null
  private options: LspClientOptions
  private shutdown = false
  private starting: Promise<boolean> | null = null

  constructor(options: LspClientOptions) {
    super()
    this.options = { timeoutMs: 15000, languageId: 'typescript', ...options }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  start(): Promise<boolean> {
    if (this.starting) return this.starting
    const pending = this.startOnce()
    this.starting = pending
    void pending.then(() => { if (this.starting === pending) this.starting = null }, () => { if (this.starting === pending) this.starting = null })
    return pending
  }

  private async startOnce(): Promise<boolean> {
    if (this.initialized) return true
    this.shutdown = false
    this.buffer = Buffer.alloc(0)

    this.serverSpec = this.options.command
      ? { command: this.options.command, args: this.options.args ?? [], languageId: this.options.languageId ?? 'typescript' }
      : detectServer(this.options.languageId, fileUriToPath(this.options.rootUri))

    if (!this.serverSpec) return false

    try {
      this.proc = spawn(this.serverSpec.command, this.serverSpec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: fileUriToPath(this.options.rootUri),
        windowsHide: true,
      })
    } catch {
      return false
    }

    const proc = this.proc
    proc.on('error', (err: Error) => {
      if (this.proc !== proc) return
      for (const { reject } of this.pending.values()) reject(err)
      this.pending.clear()
      this.initialized = false
      this.kill()
    })
    if (!proc.stdout || !proc.stdin) {
      this.kill()
      return false
    }

    // If spawn failed (nonexistent binary), pid is undefined and an
    // 'error' event fires on the next tick. Set up a guard so start()
    // rejects quickly rather than waiting for the full init timeout.
    if (!proc.pid) {
      this.kill()
      return false
    }

    // During initialization, a spawn-error (ENOENT etc.) should reject
    // the initialize request immediately instead of waiting for timeout.
    const initErrorHandler = (err: Error): void => {
      if (this.proc !== proc) return
      for (const [, { reject }] of this.pending) reject(err)
      this.pending.clear()
    }
    proc.once('error', initErrorHandler)

    proc.stdout.on('data', (data: Buffer) => {
      if (this.proc === proc) this.onData(data)
    })
    proc.stderr?.resume()
    proc.stdin.on('error', () => { if (this.proc === proc) this.kill() })
    proc.stdout.on('error', () => { if (this.proc === proc) this.kill() })
    proc.on('exit', () => {
      if (this.proc !== proc) return
      this.proc = null
      this.kill()
    })

    // Initialize
    try {
      await this.request('initialize', {
        processId: process.pid,
        rootUri: this.options.rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didOpen: true, didChange: true, didSave: true },
            publishDiagnostics: { relatedInformation: false },
          },
          workspace: { symbol: true },
        },
      }, this.options.timeoutMs)

      if (this.proc !== proc || this.shutdown) return false
      this.notify('initialized', {})
      this.initialized = true
      return true
    } catch {
      this.kill()
      return false
    }
  }

  isRunning(): boolean {
    return this.initialized && this.proc !== null
  }

  // ── Document Sync ─────────────────────────────────────────────────────

  openDocument(uri: string, text: string, languageId?: string): Promise<void> {
    return this.notifyDocument('textDocument/didOpen', {
      textDocument: {
        uri,
        languageId: languageId ?? this.options.languageId ?? 'typescript',
        version: 1,
        text,
      },
    })
  }

  changeDocument(uri: string, text: string, version: number): Promise<void> {
    return this.notifyDocument('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  saveDocument(uri: string, text?: string): Promise<void> {
    return this.notifyDocument('textDocument/didSave', {
      textDocument: { uri },
      text,
    })
  }

  closeDocument(uri: string): Promise<void> {
    return this.notifyDocument('textDocument/didClose', { textDocument: { uri } })
  }

  private notifyDocument(method: string, params: unknown): Promise<void> {
    return new Promise(resolve => {
      if (this.isRunning()) this.notify(method, params)
      resolve()
    })
  }

  // ── Diagnostics ───────────────────────────────────────────────────────

  getDiagnostics(uri?: string): LspDiagnostic[] {
    if (uri) return this.diagnostics.get(uri) ?? []
    const all: LspDiagnostic[] = []
    for (const diags of this.diagnostics.values()) all.push(...diags)
    return all
  }

  waitForDiagnostics(uri: string, timeoutMs = 5000): Promise<LspDiagnostic[]> {
    return new Promise((resolve) => {
      const existing = this.diagnostics.get(uri)
      if (existing && existing.length >= 0) {
        // Give the server a moment to publish after didOpen
      }
      const timer = setTimeout(() => {
        cleanup()
        resolve(this.diagnostics.get(uri) ?? [])
      }, timeoutMs)

      const handler = (publishedUri: string): void => {
        if (publishedUri === uri) {
          cleanup()
          resolve(this.diagnostics.get(uri) ?? [])
        }
      }

      const cleanup = (): void => {
        clearTimeout(timer)
        this.removeListener('diagnostics', handler)
      }

      this.on('diagnostics', handler)
    })
  }

  // ── Symbols ───────────────────────────────────────────────────────────

  async workspaceSymbols(query: string): Promise<LspSymbol[]> {
    if (!this.isRunning()) return []
    try {
      const result = await this.request('workspace/symbol', { query }, this.options.timeoutMs)
      return Array.isArray(result) ? result.filter(isLspSymbol) : []
    } catch {
      return []
    }
  }

  // ── Shutdown ──────────────────────────────────────────────────────────

  async stop(): Promise<void> {
    if (this.shutdown) return
    this.shutdown = true

    if (this.proc && this.initialized) {
      try {
        await this.request('shutdown', {}, 3000)
        this.notify('exit', {})
      } catch { /* ignore */ }
    }
    this.kill()
  }

  kill(): void {
    this.initialized = false
    this.buffer = Buffer.alloc(0)
    this.diagnostics.clear()
    const proc = this.proc
    this.proc = null
    if (proc) {
      try { proc.kill('SIGTERM') } catch { /* ignore */ }
    }
    for (const [, { reject }] of this.pending) reject(new Error('LSP client stopped'))
    this.pending.clear()
  }

  // ── Protocol ──────────────────────────────────────────────────────────

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data])

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) { if (this.buffer.length > 16384) this.kill(); break }
      if (headerEnd > 16384) { this.kill(); return }

      const header = this.buffer.subarray(0, headerEnd).toString('utf8')
      const matches = [...header.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
      if (matches.length !== 1) { this.kill(); return }

      const length = Number(matches[0][1])
      if (!Number.isSafeInteger(length) || length < 1 || length > 8 * 1024 * 1024) { this.kill(); return }
      const bodyStart = headerEnd + 4
      if (this.buffer.length < bodyStart + length) break

      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString('utf8')
      const remaining = this.buffer.subarray(bodyStart + length)
      this.buffer = remaining.length ? remaining : Buffer.alloc(0)

      try {
        const msg: unknown = JSON.parse(body)
        if (isRecord(msg) && msg.jsonrpc === '2.0') this.handleMessage(msg as unknown as LspMessage)
      } catch { /* malformed JSON */ }
    }
  }

  private handleMessage(msg: LspMessage): void {
    // Response to a request
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(msg.id as number)
      if (pending) {
        this.pending.delete(msg.id as number)
        if (msg.error) {
          pending.reject(new Error(msg.error.message))
        } else {
          pending.resolve(msg.result)
        }
      }
      return
    }

    // Notification
    if (msg.method) {
      switch (msg.method) {
        case 'textDocument/publishDiagnostics': {
          const params = msg.params
          if (isRecord(params) && typeof params.uri === 'string' && Array.isArray(params.diagnostics)) {
            const uri = params.uri
            const diags = params.diagnostics.filter(isRecord).map(d => normalizeDiagnostic(uri, d))
            this.diagnostics.set(params.uri, diags)
            this.emit('diagnostics', params.uri, diags)
          }
          break
        }
        case 'window/logMessage':
        case 'window/showMessage': {
          const params = msg.params as { message?: string }
          if (params?.message) this.emit('log', params.message)
          break
        }
      }
    }
  }

  private request(method: string, params: unknown, timeoutMs?: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.proc?.stdin?.writable) {
        reject(new Error('LSP server not connected'))
        return
      }

      const id = this.nextId++
      const msg: LspMessage = { jsonrpc: '2.0', id, method, params }

      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`LSP request timed out: ${method}`))
      }, timeoutMs ?? 15000)

      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })

      this.sendMessage(msg)
    })
  }

  private notify(method: string, params: unknown): void {
    if (!this.proc?.stdin?.writable) return
    this.sendMessage({ jsonrpc: '2.0', method, params })
  }

  private sendMessage(msg: LspMessage): void {
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n`
    this.proc?.stdin?.write(header + body)
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isLspSymbol(value: unknown): value is LspSymbol {
  return isRecord(value) && typeof value.name === 'string' && typeof value.kind === 'number'
    && isRecord(value.location) && typeof value.location.uri === 'string' && isLspRange(value.location.range)
    && (value.containerName === undefined || typeof value.containerName === 'string')
}

function isLspRange(value: unknown): value is LspRange {
  if (!isRecord(value)) return false
  return [value.start, value.end].every(position => isRecord(position)
    && Number.isSafeInteger(position.line) && (position.line as number) >= 0
    && Number.isSafeInteger(position.character) && (position.character as number) >= 0)
}

function normalizeDiagnostic(uri: string, raw: Record<string, unknown>): LspDiagnostic {
  const severityMap = ['error', 'warning', 'information', 'hint']
  const severity = typeof raw.severity === 'number'
    ? severityMap[raw.severity - 1] ?? 'information'
    : 'error'

  const range = isLspRange(raw.range) ? raw.range : undefined

  return {
    uri,
    range: range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    severity: severity as LspDiagnostic['severity'],
    code: typeof raw.code === 'string' || typeof raw.code === 'number' ? raw.code : undefined,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    message: typeof raw.message === 'string' ? raw.message : '(no message)',
  }
}

export function pathToFileUri(path: string): string {
  return pathToFileURL(resolve(path)).href
}

export function fileUriToPath(uri: string): string {
  if (uri.startsWith('file://')) {
    try { return fileURLToPath(uri) } catch (error) { void error }
    const path = uri.slice(7)
    if (process.platform === 'win32') {
      return decodeURIComponent(path).replace(/^\//, '').replace(/\//g, '\\')
    }
    return decodeURIComponent(path)
  }
  return uri
}

// ── Singleton Convenience ───────────────────────────────────────────────────

const defaultClients = new Map<string, LspClient>()

export function getDefaultLspClient(rootUri: string): LspClient {
  const key = pathToFileUri(fileUriToPath(rootUri))
  let client = defaultClients.get(key)
  if (!client) { client = new LspClient({ rootUri: key }); defaultClients.set(key, client) }
  return client
}

export async function shutdownDefaultLspClient(): Promise<void> {
  const clients = [...defaultClients.values()]
  defaultClients.clear()
  await Promise.all(clients.map(client => client.stop()))
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDiagnostic(d: LspDiagnostic): string {
  const pos = `${d.range.start.line + 1}:${d.range.start.character + 1}`
  const code = d.code !== undefined ? ` [${d.code}]` : ''
  const src = d.source ? ` (${d.source})` : ''
  return `${d.uri}:${pos} ${d.severity}${code}${src}: ${d.message}`
}

export function formatDiagnostics(diagnostics: LspDiagnostic[]): string {
  if (diagnostics.length === 0) return 'No diagnostics.'
  const bySeverity = {
    error: diagnostics.filter((d) => d.severity === 'error'),
    warning: diagnostics.filter((d) => d.severity === 'warning'),
    information: diagnostics.filter((d) => d.severity === 'information'),
    hint: diagnostics.filter((d) => d.severity === 'hint'),
  }
  const lines = [
    `Diagnostics: ${diagnostics.length} (${bySeverity.error.length} errors, ${bySeverity.warning.length} warnings)`,
  ]
  for (const d of diagnostics.slice(0, 50)) {
    lines.push(`  ${formatDiagnostic(d)}`)
  }
  if (diagnostics.length > 50) {
    lines.push(`  ... and ${diagnostics.length - 50} more`)
  }
  return lines.join('\n')
}
