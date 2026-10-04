/**
 * Background Session Manager
 *
 * Runs an entire ovolv999 REPL session detached from the current
 * terminal, so long-running tasks (refactors, big migrations, test
 * suites) can proceed without holding the user's TTY. The user can
 * later list, inspect, tail logs, attach, or stop these sessions via
 * the `ovolv999 ps` / `ovolv999 logs <id>` / `ovolv999 attach <id>` /
 * `ovolv999 stop <id>` CLI subcommands.
 *
 * Distinct from {@link BackgroundTaskManager}: that manages individual
 * shell subprocesses spawned by the Bash tool *within* one session;
 * this manages the sessions themselves.
 *
 * Storage layout (under ~/.ovolv999/sessions/):
 *   <id>.json   — session metadata (pid, task, cwd, status, timestamps)
 *   <id>.log    — captured stdout+stderr of the detached process
 *   <id>.exit   — written on process exit, contains the exit code
 */

import type { ChildProcess } from 'child_process'
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync,
  readdirSync, statSync, appendFileSync, openSync, closeSync, readSync, renameSync, fsyncSync,
} from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { fileURLToPath } from 'url'
import { StringDecoder } from 'string_decoder'
import type { OutcomeStatus, VerificationEvidence } from './outcome.js'
import { withPersistenceLock, withPersistenceLockAsync } from './persistenceLock.js'
import { inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { spawnManaged } from './executionBackend.js'
import { buildChildEnvironment, mergeChildEnvironment, resolveExecutionPolicy, type ExecutionPolicy } from './executionPolicy.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type SessionStatus = 'starting' | 'running' | 'stopping' | 'stop_failed' | 'stopped' | 'unknown' | OutcomeStatus

export interface SessionMetadata {
  schemaVersion?: number
  revision?: number
  id: string
  task: string
  cwd: string
  model?: string
  pid: number | null
  startedAt: string
  endedAt?: string
  status: SessionStatus
  logPath: string
  exitCode?: number
  outcome?: OutcomeStatus
  verification?: VerificationEvidence
  /** Extra args passed to the spawned ovolv999 */
  args?: string[]
  processIdentity?: ProcessIdentity
  supervisorIdentity?: ProcessIdentity
  stopRequestedAt?: string
  stopGraceMs?: number
  diagnostic?: string
}

export interface StartSessionOptions {
  task: string
  cwd?: string
  model?: string
  /** Extra CLI args to forward to the spawned ovolv999 */
  extraArgs?: string[]
  /** Environment override (defaults to process.env) */
  env?: NodeJS.ProcessEnv
  readyTimeoutMs?: number
  executable?: string
  executionPolicy?: ExecutionPolicy
}

export interface StartSessionResult {
  sessionId: string
  pid: number | null
  logPath: string
}

export interface LogReadOptions {
  /** Number of lines from the tail (default: all) */
  tailLines?: number
  /** Start byte offset (alternative to tailLines) */
  startOffset?: number
  maxBytes?: number
}

export interface StopSessionResult {
  accepted: boolean
  status: 'stopped' | 'stopping' | 'failed' | 'not_found'
  reason?: string
}

export interface AttachResult {
  /** Stream of new log lines (after attach point) */
  stream: AsyncIterable<string>
  /** Stop watching and clean up */
  stop: () => void
  /** Current metadata snapshot */
  metadata: SessionMetadata
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getSessionsDir(): string {
  return join(homedir(), '.ovolv999', 'sessions')
}

export function getMetadataPath(id: string): string {
  validateId(id)
  return join(getSessionsDir(), `${id}.json`)
}

export function getLogPath(id: string): string {
  validateId(id)
  return join(getSessionsDir(), `${id}.log`)
}

export function getExitPath(id: string): string {
  validateId(id)
  return join(getSessionsDir(), `${id}.exit`)
}

function ensureSessionsDir(): void {
  const dir = getSessionsDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

// ── ID Generation ───────────────────────────────────────────────────────────

export function generateSessionId(): string {
  const ts = Date.now().toString(36)
  const rand = randomBytes(4).toString('hex')
  return `sess-${ts}-${rand}`
}

// ── Metadata I/O ────────────────────────────────────────────────────────────

function validateId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('Invalid background session ID')
}

function validateMetadata(value: unknown, id: string): SessionMetadata {
  if (!value || typeof value !== 'object') throw new Error(`Invalid background metadata: ${id}`)
  const meta = value as SessionMetadata
  if (meta.schemaVersion !== undefined && meta.schemaVersion !== 1) throw new Error(`Unsupported background metadata version: ${meta.schemaVersion}`)
  if (meta.id !== id || typeof meta.task !== 'string' || typeof meta.cwd !== 'string' || typeof meta.logPath !== 'string' || typeof meta.startedAt !== 'string' || !Number.isFinite(Date.parse(meta.startedAt)) || !Object.hasOwn(STATUS_ICON, meta.status) || (meta.pid !== null && (!Number.isInteger(meta.pid) || meta.pid <= 0))) throw new Error(`Invalid background metadata: ${id}`)
  if (meta.revision !== undefined && (!Number.isSafeInteger(meta.revision) || meta.revision < 1)) throw new Error(`Invalid background metadata revision: ${id}`)
  if (meta.exitCode !== undefined && !Number.isInteger(meta.exitCode)) throw new Error(`Invalid background exit code: ${id}`)
  return meta
}

function writeMetadata(meta: SessionMetadata): void {
  validateMetadata(meta, meta.id)
  const path = getMetadataPath(meta.id)
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(meta, null, 2))
    fsyncSync(fd)
  } finally { closeSync(fd) }
  try { renameSync(temporary, path) } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

export function saveMetadata(meta: SessionMetadata): void {
  ensureSessionsDir()
  withPersistenceLock(getMetadataPath(meta.id), () => {
    const current = loadMetadata(meta.id)
    if (current && meta.revision !== current.revision) throw new Error(`Background metadata revision conflict: ${meta.id}`)
    const updated = { ...meta, schemaVersion: 1, revision: (current?.revision ?? 0) + 1 }
    writeMetadata(updated)
    Object.assign(meta, updated)
  })
}

export function loadMetadata(id: string): SessionMetadata | null {
  const path = getMetadataPath(id)
  if (!existsSync(path)) return null
  if (statSync(path).size > 1024 * 1024) throw new Error(`Background metadata exceeds byte limit: ${id}`)
  return validateMetadata(JSON.parse(readFileSync(path, 'utf8')), id)
}

export function updateMetadata(id: string, patch: Partial<SessionMetadata>): SessionMetadata | null {
  ensureSessionsDir()
  return withPersistenceLock(getMetadataPath(id), () => patchMetadata(id, patch))
}

function patchMetadata(id: string, patch: Partial<SessionMetadata>): SessionMetadata | null {
  const current = loadMetadata(id)
  if (!current) return null
  if (patch.id !== undefined && patch.id !== id) throw new Error('Background session identity is immutable')
  if (patch.revision !== undefined && patch.revision !== current.revision) throw new Error(`Background metadata revision conflict: ${id}`)
  const updated = { ...current, ...patch, id, schemaVersion: 1, revision: (current.revision ?? 0) + 1 }
  writeMetadata(updated)
  return updated
}

export async function updateMetadataAsync(id: string, patch: Partial<SessionMetadata>): Promise<SessionMetadata | null> {
  ensureSessionsDir()
  return withPersistenceLockAsync(getMetadataPath(id), () => patchMetadata(id, patch))
}

export function recordBackgroundOutcome(outcome: OutcomeStatus, verification?: VerificationEvidence): void {
  const id = process.env.OVOGV999_SESSION_ID
  if (!id) return
  updateMetadata(id, { outcome, verification })
}

// ── Liveness ────────────────────────────────────────────────────────────────

/**
 * Check if a PID is still alive. Uses process.kill(pid, 0) which
 * throws ESRCH if the process doesn't exist. Detached children get
 * reparented to init, so this works even though we're not the parent.
 */
export function isPidAlive(pid: number | null): boolean {
  if (!pid || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Refresh a session's status by checking process liveness + exit file.
 * Updates the metadata on disk if the status changed.
 */
export function refreshSessionStatus(id: string): SessionMetadata | null {
  const meta = loadMetadata(id)
  if (!meta) return null
  if (!['starting', 'running', 'stopping'].includes(meta.status)) return meta
  if (meta.supervisorIdentity) {
    if (isPidAlive(meta.supervisorIdentity.pid)) return meta
    return updateMetadata(id, { status: 'unknown', diagnostic: 'Supervisor exited; process resources require recovery' })
  }

  // Check exit code file first (written by wrapper or reaper)
  const exitPath = getExitPath(id)
  let exitCode: number | undefined
  if (existsSync(exitPath)) {
    try {
      exitCode = parseInt(readFileSync(exitPath, 'utf8').trim(), 10)
    } catch { /* ignore */ }
  }

  const alive = isPidAlive(meta.pid)
  if (alive) return meta

  // Process ended
  const newStatus: SessionStatus =
    exitCode === undefined ? (meta.outcome === 'cancelled' ? 'cancelled' : 'unknown') :
    exitCode === 0 ? (meta.outcome ?? 'unknown') :
    meta.outcome && meta.outcome !== 'completed' ? meta.outcome :
    exitCode === 124 ? 'limit_reached' :
    exitCode === 2 ? 'blocked' :
    exitCode === 130 ? 'stopped' :
    'failed'

  return updateMetadata(id, {
    status: newStatus,
    endedAt: new Date().toISOString(),
    exitCode,
  })
}

// ── Start Session ───────────────────────────────────────────────────────────

/**
 * Resolve the ovolv999 executable to spawn. Honors the OVOGV999_BIN
 * env var (useful for tests), otherwise uses process.argv[1].
 */
function resolveOvogogogoBin(): string {
  if (process.env.OVOGV999_BIN) return process.env.OVOGV999_BIN
  if (process.argv[1]) return process.argv[1]
  return 'ovolv999'
}

export async function startBackgroundSession(options: StartSessionOptions): Promise<StartSessionResult> {
  ensureSessionsDir()
  const id = generateSessionId()
  const logPath = getLogPath(id)
  const cwd = options.cwd ?? process.cwd()
  const executionPolicy = options.executionPolicy ?? resolveExecutionPolicy(undefined, cwd)
  const workerEnvironment = mergeChildEnvironment(buildChildEnvironment(executionPolicy, process.env), options.env ?? {})
  const workerPolicy = { ...executionPolicy, envAllowlist: [...executionPolicy.envAllowlist, ...Object.keys(options.env ?? {}), 'OVOGV999_SESSION_ID', 'OVOGV999_SUPERVISED'] }
  const spawnArgs = [options.task, '--cwd', cwd]
  if (options.model) spawnArgs.push('--model', options.model)
  if (options.extraArgs) spawnArgs.push(...options.extraArgs)
  writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 })
  saveMetadata({ id, task: options.task, cwd, model: options.model, pid: null, startedAt: new Date().toISOString(), status: 'starting', logPath, args: spawnArgs })
  const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
  const diagnosticFd = openSync(logPath, 'a')
  let supervisor: ChildProcess
  try {
    supervisor = spawnManaged(process.execPath, [...(extension === 'ts' ? ['--import', import.meta.resolve('tsx')] : []), fileURLToPath(new URL(`./backgroundSupervisor.${extension}`, import.meta.url))], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', diagnosticFd, diagnosticFd, 'ipc'],
      env: buildChildEnvironment(executionPolicy, process.env),
      policy: executionPolicy,
    })
  } finally { closeSync(diagnosticFd) }
  const timeoutMs = options.readyTimeoutMs ?? 30_000
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, pid?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (supervisor.connected) supervisor.disconnect()
      supervisor.unref()
      if (error) reject(error)
      else resolve({ sessionId: id, pid: pid ?? null, logPath })
    }
    const timer = setTimeout(() => {
      void updateMetadataAsync(id, { stopRequestedAt: new Date().toISOString(), stopGraceMs: 0 }).then(() => finish(new Error(`Background session ready handshake timed out: ${id}`)), (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
    }, timeoutMs + 2000)
    supervisor.once('error', error => {
      void updateMetadataAsync(id, { status: 'failed', diagnostic: error.message }).finally(() => finish(error))
    })
    supervisor.once('exit', (code) => {
      if (settled) return
      const error = new Error(`Background supervisor exited before ready (exit ${code}): ${id}; inspect ${logPath}`)
      void updateMetadataAsync(id, { status: 'failed', diagnostic: error.message }).then(() => finish(error), () => finish(error))
    })
    supervisor.on('message', (message: unknown) => {
      const response = message as { type?: string; pid?: number; error?: string }
      if (response.type === 'ready') finish(undefined, response.pid)
      if (response.type === 'error') finish(new Error(response.error ?? 'Background start failed'))
    })
    supervisor.send({ id, executable: options.executable ?? process.execPath, args: [resolveOvogogogoBin(), ...spawnArgs], cwd, timeoutMs, env: workerEnvironment, executionPolicy: workerPolicy }, error => { if (error) finish(error) })
  })
}

export async function stopSession(id: string, graceMs = 5000): Promise<StopSessionResult> {
  const meta = loadMetadata(id)
  if (!meta) return { accepted: false, status: 'not_found' }
  if (!meta.pid || !isPidAlive(meta.pid)) {
    if (meta.supervisorIdentity && await inspectProcessIdentity(meta.supervisorIdentity) === 'matching') {
      await updateMetadataAsync(id, { stopRequestedAt: new Date().toISOString(), stopGraceMs: graceMs })
    } else if (meta.processIdentity || meta.supervisorIdentity || meta.status === 'unknown') {
      return { accepted: false, status: 'failed', reason: 'Supervisor unavailable; retained resources require recovery' }
    } else {
      await updateMetadataAsync(id, { status: 'stopped', endedAt: new Date().toISOString() })
      return { accepted: true, status: 'stopped' }
    }
  } else {
    if (!meta.processIdentity || await inspectProcessIdentity(meta.processIdentity) !== 'matching') return { accepted: false, status: 'failed', reason: 'Process identity is missing or does not match; refusing to signal' }
    if (!meta.supervisorIdentity || await inspectProcessIdentity(meta.supervisorIdentity) !== 'matching') return { accepted: false, status: 'failed', reason: 'Supervisor unavailable; retained resources require recovery' }
    await updateMetadataAsync(id, { status: 'stopping', stopRequestedAt: new Date().toISOString(), stopGraceMs: graceMs })
  }
  const deadline = Date.now() + Math.max(0, graceMs) + 10_000
  while (Date.now() < deadline) {
    const fresh = loadMetadata(id)
    if (!fresh) return { accepted: true, status: 'failed', reason: 'Session metadata disappeared during stop' }
    if (fresh.status === 'stopped' || fresh.status === 'cancelled') return { accepted: true, status: 'stopped' }
    if (fresh.status === 'stop_failed' || fresh.status === 'unknown') return { accepted: true, status: 'failed', reason: fresh.diagnostic }
    if (fresh.supervisorIdentity && !isPidAlive(fresh.supervisorIdentity.pid)) return { accepted: true, status: 'failed', reason: 'Supervisor exited before physical stop confirmation' }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  return { accepted: true, status: 'stopping', reason: 'Stop request accepted; physical termination remains unconfirmed' }
}
// ── List / Get ──────────────────────────────────────────────────────────────

export function listSessions(): SessionMetadata[] {
  const dir = getSessionsDir()
  if (!existsSync(dir)) return []

  const sessions: SessionMetadata[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    const id = file.slice(0, -5)
    const meta = refreshSessionStatus(id)
    if (meta) sessions.push(meta)
  }

  // Most recent first
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  return sessions
}

export function getSession(id: string): SessionMetadata | null {
  return refreshSessionStatus(id)
}

// ── Logs ────────────────────────────────────────────────────────────────────

const MAX_LOG_READ_BYTES = 1024 * 1024
const LOG_CHUNK_BYTES = 64 * 1024

function readRange(path: string, offset: number, length: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const size = readSync(fd, buffer, 0, length, offset)
    return buffer.subarray(0, size)
  } finally { closeSync(fd) }
}

export function readSessionLogs(id: string, opts: LogReadOptions = {}): string {
  const path = getLogPath(id)
  if (!existsSync(path)) return ''
  const size = statSync(path).size
  const limit = opts.maxBytes ?? MAX_LOG_READ_BYTES
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) throw new Error('Invalid log byte limit')
  if (opts.tailLines !== undefined) {
    if (!Number.isSafeInteger(opts.tailLines) || opts.tailLines < 0) throw new Error('Invalid tail line count')
    if (opts.tailLines === 0) return ''
    let offset = size
    let data = Buffer.alloc(0)
    while (offset > 0) {
      const length = Math.min(LOG_CHUNK_BYTES, offset, limit - data.length)
      if (length <= 0) throw new Error(`Log tail exceeds ${limit} bytes; request fewer lines`)
      offset -= length
      data = Buffer.concat([readRange(path, offset, length), data])
      const lines = data.toString('utf8').split('\n')
      if (lines[lines.length - 1] === '') lines.pop()
      if (lines.length > opts.tailLines || offset === 0) return lines.slice(-opts.tailLines).join('\n')
    }
    return ''
  }
  const offset = opts.startOffset ?? 0
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid log byte offset')
  const length = Math.max(0, size - offset)
  if (length > limit) throw new Error(`Log read exceeds ${limit} bytes; use --tail or a later offset`)
  return readRange(path, offset, length).toString('utf8')
}

export function getLogSize(id: string): number {
  try { return statSync(getLogPath(id)).size } catch { return 0 }
}

export interface AttachOptions {
  maxQueueBytes?: number
  maxQueueLines?: number
  maxLineBytes?: number
}

export function attachToSession(id: string, pollMs = 500, options: AttachOptions = {}): AttachResult | null {
  const meta = getSession(id)
  if (!meta) return null
  const path = getLogPath(id)
  const maxBytes = options.maxQueueBytes ?? 512 * 1024
  const maxLines = options.maxQueueLines ?? 4096
  const maxLine = options.maxLineBytes ?? 256 * 1024
  for (const limit of [maxBytes, maxLines, maxLine]) if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid attachment capacity')
  let offset = getLogSize(id)
  let identity = existsSync(path) ? `${statSync(path).dev}:${statSync(path).ino}` : ''
  let decoder = new StringDecoder('utf8')
  let partial = ''
  let stopped = false
  let failure: Error | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queueBytes = 0
  const queue: string[] = []
  let pending: { resolve: (value: IteratorResult<string>) => void; reject: (error: Error) => void } | undefined
  const finish = (error?: Error, clear = false): void => {
    stopped = true
    failure = error
    if (timer) clearTimeout(timer)
    timer = undefined
    if (clear || error) { queue.length = 0; queueBytes = 0; partial = '' }
    if (pending) {
      const waiter = pending
      pending = undefined
      if (error) waiter.reject(error)
      else waiter.resolve({ value: undefined, done: true })
    }
  }
  const emit = (line: string): void => {
    const bytes = Buffer.byteLength(line)
    if (bytes > maxLine) throw new Error('Attachment line byte limit exceeded; inspect retained log files')
    if (pending) {
      const waiter = pending
      pending = undefined
      waiter.resolve({ value: line, done: false })
    } else {
      if (queue.length >= maxLines || queueBytes + bytes > maxBytes) throw new Error('Attachment queue limit exceeded; consumer is too slow, inspect retained log files')
      queue.push(line)
      queueBytes += bytes
    }
  }
  const ingest = (text: string): void => {
    partial += text
    let newline: number
    while ((newline = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, newline).replace(/\r$/, '')
      partial = partial.slice(newline + 1)
      emit(line)
    }
    if (Buffer.byteLength(partial) > maxLine) throw new Error('Attachment line byte limit exceeded; inspect retained log files')
  }
  const poll = (): void => {
    if (stopped) return
    try {
      if (existsSync(path)) {
        const stat = statSync(path)
        const freshIdentity = `${stat.dev}:${stat.ino}`
        if (freshIdentity !== identity) {
          if (identity) {
            const previousPath = `${path}.1`
            const previous = existsSync(previousPath) ? statSync(previousPath) : undefined
            if (!previous || `${previous.dev}:${previous.ino}` !== identity) throw new Error('Log rotation exceeded retained history; unread output may be missing')
            while (offset < previous.size) {
              const data = readRange(previousPath, offset, Math.min(LOG_CHUNK_BYTES, previous.size - offset))
              if (!data.length) throw new Error('Rotated log changed while reading; unread output may be missing')
              offset += data.length
              ingest(decoder.write(data))
            }
          }
          offset = 0
          identity = freshIdentity
        } else if (stat.size < offset) {
          partial = ''
          decoder = new StringDecoder('utf8')
          offset = 0
        }
        if (stat.size > offset) {
          const data = readRange(path, offset, Math.min(LOG_CHUNK_BYTES, stat.size - offset))
          offset += data.length
          ingest(decoder.write(data))
        }
      }
      const fresh = getSession(id)
      if ((!fresh || (!['starting', 'running', 'stopping'].includes(fresh.status) && !isPidAlive(fresh.pid))) && offset >= getLogSize(id)) {
        ingest(decoder.end())
        if (partial) { emit(partial); partial = '' }
        finish()
        return
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), true)
      return
    }
    timer = setTimeout(poll, pollMs)
  }
  timer = setTimeout(poll, 0)
  const iterator: AsyncIterator<string> = {
    next(): Promise<IteratorResult<string>> {
      if (failure) return Promise.reject(failure)
      if (queue.length) {
        const line = queue.shift()!
        queueBytes -= Buffer.byteLength(line)
        return Promise.resolve({ value: line, done: false })
      }
      if (stopped) return Promise.resolve({ value: undefined, done: true })
      if (pending) return Promise.reject(new Error('Only one pending attachment read is supported'))
      return new Promise((resolve, reject) => { pending = { resolve, reject } })
    },
    return(): Promise<IteratorResult<string>> {
      finish(undefined, true)
      return Promise.resolve({ value: undefined, done: true })
    },
  }
  return { stream: { [Symbol.asyncIterator]: () => iterator }, stop: () => finish(undefined, true), metadata: meta }
}
// ── Remove / Clean ──────────────────────────────────────────────────────────

export function removeSession(id: string, _force = false): boolean {
  const meta = loadMetadata(id)
  if (!meta) return false

  // Don't remove running sessions unless forced
  if (meta.status === 'unknown' || meta.status === 'stop_failed' || isPidAlive(meta.pid) || (meta.supervisorIdentity && isPidAlive(meta.supervisorIdentity.pid))) {
    return false
  }

  for (const path of [getMetadataPath(id), getLogPath(id), getExitPath(id)]) {
    if (existsSync(path)) {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  }
  return true
}

export function cleanStaleSessions(maxAge = 7 * 24 * 60 * 60 * 1000): number {
  const sessions = listSessions()
  const cutoff = Date.now() - maxAge
  let removed = 0
  for (const s of sessions) {
    if (['starting', 'running', 'stopping', 'stop_failed', 'unknown'].includes(s.status)) continue
    const started = new Date(s.startedAt).getTime()
    if (started < cutoff) {
      if (removeSession(s.id, true)) removed++
    }
  }
  return removed
}

// ── Child-side log capture ──────────────────────────────────────────────────

/**
 * Called by the spawned ovolv999 process itself: redirects its stdout
 * and stderr to the session log file when OVOGV999_SESSION_ID is set.
 * This is how background sessions capture their output.
 */
export function initChildLogCapture(): string | null {
  const sessionId = process.env.OVOGV999_SESSION_ID
  if (!sessionId) return null
  if (process.env.OVOGV999_SUPERVISED === '1') return sessionId

  const logPath = getLogPath(sessionId)
  ensureSessionsDir()

  // Tee: write to the log AND keep the original stream (so pipe mode
  // still works if someone backgrounds a pipe run).
  const origWrite = process.stdout.write.bind(process.stdout)
  const origErrWrite = process.stderr.write.bind(process.stderr)

  const appendLog = (data: unknown): void => {
    try {
      appendFileSync(logPath, data as string | Uint8Array)
    } catch { /* ignore disk errors */ }
  }

  process.stdout.write = (data: unknown): boolean => {
    appendLog(data)
    return origWrite(data as string | Uint8Array)
  }
  process.stderr.write = (data: unknown): boolean => {
    appendLog(data)
    return origErrWrite(data as string | Uint8Array)
  }

  // Write exit code on process end
  process.on('exit', (code) => {
    try {
      writeFileSync(getExitPath(sessionId), `${code ?? 0}\n`)
    } catch { /* ignore */ }
  })

  return sessionId
}

export function markBackgroundReady(): void {
  if (process.env.OVOGV999_SUPERVISED === '1' && process.connected) process.send?.({ type: 'ovogo:ready' }, () => {})
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSessionList(sessions: SessionMetadata[]): string {
  if (sessions.length === 0) return 'No background sessions.'
  const lines: string[] = ['Background sessions:', '']
  for (const s of sessions) {
    const status = STATUS_ICON[s.status] ?? '?'
    const age = formatAge(s.startedAt)
    const task = s.task.length > 50 ? s.task.slice(0, 47) + '...' : s.task
    lines.push(`  ${status} ${s.id}  ${task}  (${age})`)
  }
  return lines.join('\n')
}

export function formatSessionDetail(meta: SessionMetadata): string {
  const lines: string[] = [
    `Session: ${meta.id}`,
    `  Task: ${meta.task}`,
    `  Status: ${meta.status}${meta.exitCode !== undefined ? ` (exit ${meta.exitCode})` : ''}`,
    `  PID: ${meta.pid ?? 'n/a'}${meta.pid && isPidAlive(meta.pid) ? ' (alive)' : ''}`,
    `  Started: ${meta.startedAt}`,
  ]
  if (meta.endedAt) lines.push(`  Ended: ${meta.endedAt}`)
  if (meta.model) lines.push(`  Model: ${meta.model}`)
  lines.push(`  CWD: ${meta.cwd}`)
  lines.push(`  Log: ${meta.logPath}`)
  return lines.join('\n')
}

const STATUS_ICON: Record<SessionStatus, string> = {
  starting: '○',
  stopping: '◌',
  stop_failed: '!',
  running: '●',
  completed: '✓',
  failed: '✗',
  stopped: '◼',
  unknown: '?',
  cancelled: '◼',
  interrupted: '◼',
  limit_reached: '◼',
  blocked: '◼',
  needs_input: '?',
}

function formatAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`
  return `${Math.round(ms / 86_400_000)}d ago`
}
