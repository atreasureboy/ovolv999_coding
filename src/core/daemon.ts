/**
 * Daemon Mode — long-running background supervisor
 *
 * Lets the tool run as a persistent daemon that can:
 *   - Accept commands via a Unix socket
 *   - Run scheduled tasks
 *   - Monitor file changes
 *   - Manage background agents
 *
 * Inspired by claude-code's daemon mode.
 */

import { createServer, type Server, Socket } from 'net'
import { existsSync, unlinkSync, mkdirSync, appendFileSync, renameSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHash } from 'crypto'
import { StringDecoder } from 'string_decoder'
import { isRecord } from './persistedData.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type DaemonStatus = 'running' | 'stopped' | 'starting' | 'error'

export interface DaemonInfo {
  pid: number
  status: DaemonStatus
  startTime: string
  socketPath: string
  logPath: string
  workers: number
  uptime: number
}

export interface DaemonCommand {
  action: 'status' | 'stop' | 'ping' | 'health' | 'list-workers' | 'restart-worker'
  payload?: Record<string, unknown>
}

export interface DaemonResponse {
  ok: boolean
  data?: unknown
  error?: string
}

interface WorkerEntry {
  id: string
  name: string
  pid?: number
  status: 'starting' | 'running' | 'stopped' | 'failed'
  startedAt: string
  command?: string
}

export type { WorkerEntry }

export interface DaemonOptions {
  drainTimeoutMs?: number
  maxLogBytes?: number
  maxConnections?: number
  maxFrameBytes?: number
  maxWorkers?: number
}

export function resolveDaemonSocketPath(path: string): string {
  if (process.platform !== 'win32' || path.startsWith('\\\\.\\pipe\\')) return path
  return `\\\\.\\pipe\\ovolv999-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`
}

// ── Daemon ──────────────────────────────────────────────────────────────────

export class Daemon {
  private server: Server | null = null
  private startTime: number = 0
  private workers = new Map<string, WorkerEntry>()
  private status: DaemonStatus = 'stopped'
  private readonly connections = new Set<Socket>()
  private stopPromise?: Promise<void>
  private startPromise?: Promise<void>
  private logHealthy = true
  private ownsEndpoint = false
  private readonly socketPath: string
  private readonly options: Required<DaemonOptions>

  constructor(
    socketPath: string,
    private readonly logPath: string,
    options: DaemonOptions = {},
  ) {
    this.socketPath = resolveDaemonSocketPath(socketPath)
    this.options = { drainTimeoutMs: 500, maxLogBytes: 1024 * 1024, maxConnections: 64, maxFrameBytes: 64 * 1024, maxWorkers: 64, ...options }
    for (const value of Object.values(this.options)) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid daemon capacity')
  }

  start(): Promise<void> {
    if (this.startPromise) return this.startPromise
    if (this.stopPromise && this.status === 'stopped') {
      const stopping = this.stopPromise
      return stopping.then(() => { if (this.stopPromise === stopping) this.stopPromise = undefined; return this.start() })
    }
    const pending = this.startOnce()
    this.startPromise = pending
    void pending.then(() => { this.startPromise = undefined }, () => { this.startPromise = undefined })
    return pending
  }

  private async startOnce(): Promise<void> {
    if (this.status === 'running') return

    this.status = 'starting'

    this.stopPromise = undefined

    // Ensure log dir exists
    const logDir = join(this.logPath, '..')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })

    return new Promise((resolve, reject) => {
      this.server = createServer((socket: Socket) => {
        if (this.connections.size >= this.options.maxConnections) { socket.destroy(); return }
        this.connections.add(socket)
        socket.once('close', () => this.connections.delete(socket))
        socket.on('error', () => socket.destroy())
        this.handleConnection(socket)
      })

      this.server.on('error', (err) => {
        this.status = 'error'
        this.log(`Daemon error: ${err.message}`)
        reject(err)
      })

      this.server.listen(this.socketPath, () => {
        this.ownsEndpoint = true
        this.status = 'running'
        this.startTime = Date.now()
        this.log(`Daemon started (pid=${process.pid}, socket=${this.socketPath})`)
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.status = 'stopped'
    const starting = this.startPromise
    this.stopPromise = (async () => {
      await starting?.catch(() => undefined)
      this.status = 'stopped'
      if (this.server) {
        const server = this.server
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => { for (const socket of this.connections) socket.destroy() }, this.options.drainTimeoutMs)
          server.close(() => { clearTimeout(timer); resolve() })
          for (const socket of this.connections) socket.end()
        })
        this.server = null
      }
      if (this.ownsEndpoint && process.platform !== 'win32' && existsSync(this.socketPath)) unlinkSync(this.socketPath)
      this.ownsEndpoint = false
      this.log('Daemon stopped')
    })()
    return this.stopPromise
  }

  getInfo(): DaemonInfo {
    return {
      pid: process.pid,
      status: this.status,
      startTime: new Date(this.startTime).toISOString(),
      socketPath: this.socketPath,
      logPath: this.logPath,
      workers: this.workers.size,
      uptime: Date.now() - this.startTime,
    }
  }

  addWorker(name: string, command?: string): WorkerEntry {
    if (this.workers.size >= this.options.maxWorkers) throw new Error('Daemon worker capacity exceeded')
    const id = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const worker: WorkerEntry = {
      id,
      name,
      status: 'starting',
      startedAt: new Date().toISOString(),
      command,
    }
    this.workers.set(id, worker)
    this.log(`Worker added: ${name} (${id})`)
    return worker
  }

  removeWorker(id: string): boolean {
    const existed = this.workers.delete(id)
    if (existed) this.log(`Worker removed: ${id}`)
    return existed
  }

  listWorkers(): WorkerEntry[] {
    return Array.from(this.workers.values())
  }

  updateWorkerStatus(id: string, status: WorkerEntry['status'], pid?: number): void {
    const worker = this.workers.get(id)
    if (worker) {
      worker.status = status
      if (pid !== undefined) worker.pid = pid
    }
  }

  private handleConnection(socket: Socket): void {
    let buffer = ''
    let failed = false
    const decoder = new StringDecoder('utf8')
    socket.on('data', (data: Buffer) => {
      if (failed) return
      buffer += decoder.write(data)
      let nl = buffer.indexOf('\n')
      while (nl !== -1) {
        const frame = buffer.slice(0, nl)
        if (Buffer.byteLength(frame) > this.options.maxFrameBytes) {
          failed = true
          socket.end(JSON.stringify({ ok: false, error: 'Daemon frame byte limit exceeded' }) + '\n')
          return
        }
        const line = frame.trim()
        buffer = buffer.slice(nl + 1)
        nl = buffer.indexOf('\n')
        if (!line) continue
        try {
          const cmd = JSON.parse(line) as DaemonCommand
          if (!cmd || typeof cmd.action !== 'string') throw new Error('Invalid daemon command')
          const response = this.handleCommand(cmd)
          if (!socket.write(JSON.stringify(response) + '\n')) { socket.pause(); socket.once('drain', () => socket.resume()) }
          if (socket.writableLength > 1024 * 1024) { socket.destroy(); return }
        } catch (err) {
          const response: DaemonResponse = { ok: false, error: err instanceof Error ? err.message : String(err) }
          socket.write(JSON.stringify(response) + '\n')
        }
      }
      if (Buffer.byteLength(buffer) > this.options.maxFrameBytes) {
        failed = true
        socket.end(JSON.stringify({ ok: false, error: 'Daemon frame byte limit exceeded' }) + '\n')
      }
    })
  }

  private handleCommand(cmd: DaemonCommand): DaemonResponse {
    switch (cmd.action) {
      case 'ping':
        return { ok: true, data: 'pong' }
      case 'status':
        return { ok: true, data: this.getInfo() }
      case 'health':
        return {
          ok: true,
          data: {
            status: this.status,
            uptime: Date.now() - this.startTime,
            workers: this.workers.size,
            memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
            logHealthy: this.logHealthy,
            connections: this.connections.size,
          },
        }
      case 'stop':
        setImmediate(() => { void this.stop() })
        return { ok: true, data: 'stopping' }
      case 'list-workers':
        return { ok: true, data: this.listWorkers() }
      default:
        return { ok: false, error: `Unknown action: ${cmd.action}` }
    }
  }

  private log(message: string): void {
    try {
      const timestamp = new Date().toISOString()
      const line = `[${timestamp}] ${message.slice(0, 16_000)}\n`
      if (existsSync(this.logPath) && statSync(this.logPath).size + Buffer.byteLength(line) > this.options.maxLogBytes) {
        if (existsSync(`${this.logPath}.1`)) unlinkSync(`${this.logPath}.1`)
        renameSync(this.logPath, `${this.logPath}.1`)
      }
      appendFileSync(this.logPath, line, { mode: 0o600 })
      this.logHealthy = true
    } catch { this.logHealthy = false }
  }
}

// ── Daemon Client ───────────────────────────────────────────────────────────

export class DaemonClient {
  private readonly socketPath: string
  constructor(socketPath: string) { this.socketPath = resolveDaemonSocketPath(socketPath) }

  async send(cmd: DaemonCommand, timeoutMs = 5000): Promise<DaemonResponse> {
    if (process.platform !== 'win32' && !existsSync(this.socketPath)) {
      return { ok: false, error: 'Daemon socket not found. Is the daemon running?' }
    }

    return new Promise((resolve) => {
      const socket = new Socket()
      let buffer = ''
      const decoder = new StringDecoder('utf8')
      let settled = false

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          socket.destroy()
          resolve({ ok: false, error: `Daemon request timed out after ${timeoutMs}ms` })
        }
      }, timeoutMs)

      socket.on('connect', () => {
        socket.write(JSON.stringify(cmd) + '\n')
      })

      socket.on('data', (data: Buffer) => {
        buffer += decoder.write(data)
        if (Buffer.byteLength(buffer) > 1024 * 1024 && !settled) {
          settled = true
          clearTimeout(timer)
          socket.destroy()
          resolve({ ok: false, error: 'Daemon response byte limit exceeded' })
          return
        }
        const nl = buffer.indexOf('\n')
        if (nl !== -1 && !settled) {
          settled = true
          clearTimeout(timer)
          const line = buffer.slice(0, nl).trim()
          try {
            const response: unknown = JSON.parse(line)
            resolve(isRecord(response) && typeof response.ok === 'boolean'
              && (response.error === undefined || typeof response.error === 'string')
              ? response as unknown as DaemonResponse : { ok: false, error: 'Invalid daemon response' })
          } catch {
            resolve({ ok: false, error: 'Invalid daemon response' })
          }
          socket.destroy()
        }
      })

      socket.on('error', (err) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          socket.destroy()
          resolve({ ok: false, error: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'Daemon socket not found. Is the daemon running?' : err.message })
        }
      })
      socket.on('close', () => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, error: 'Daemon disconnected before responding' }) }
      })

      socket.connect(this.socketPath)
    })
  }

  async ping(): Promise<boolean> {
    const res = await this.send({ action: 'ping' })
    return res.ok && res.data === 'pong'
  }

  async status(): Promise<DaemonInfo | null> {
    const res = await this.send({ action: 'status' })
    return res.ok ? res.data as DaemonInfo : null
  }

  async stop(): Promise<boolean> {
    const res = await this.send({ action: 'stop' })
    return res.ok
  }
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getDaemonSocketPath(): string {
  return resolveDaemonSocketPath(join(homedir(), '.ovolv999', 'daemon.sock'))
}

export function getDaemonLogPath(): string {
  return join(homedir(), '.ovolv999', 'daemon.log')
}

export async function isDaemonRunning(): Promise<boolean> {
  return new DaemonClient(getDaemonSocketPath()).ping()
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatDaemonInfo(info: DaemonInfo): string {
  const lines: string[] = [
    `Daemon Status: ${info.status}`,
    `  PID: ${info.pid}`,
    `  Started: ${info.startTime}`,
    `  Uptime: ${(info.uptime / 1000 / 60).toFixed(1)} minutes`,
    `  Socket: ${info.socketPath}`,
    `  Log: ${info.logPath}`,
    `  Workers: ${info.workers}`,
  ]
  return lines.join('\n')
}

export function formatWorkers(workers: WorkerEntry[]): string {
  if (workers.length === 0) return 'No workers registered.'
  const lines: string[] = [`Workers (${workers.length}):`]
  for (const w of workers) {
    const icon = { starting: '○', running: '●', stopped: '⊘', failed: '✗' }[w.status]
    lines.push(`  ${icon} ${w.name} (${w.id}) — ${w.status}`)
  }
  return lines.join('\n')
}
