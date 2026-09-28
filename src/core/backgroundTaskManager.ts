/**
 * Background Task Manager — async long-running task lifecycle
 *
 * Inspired by Claude Code's TaskStop/TaskOutput + TaskCreate/List/Get/Update.
 *
 * Fills ovolv999's gap: the Bash tool can spawn background processes
 * (run_in_background:true) but there was no way to later check their status,
 * retrieve output, or stop them. This manager provides that lifecycle:
 *
 *   createTask(cmd) → id   (spawn async, return immediately)
 *   getTask(id)            (status, exitCode, output preview)
 *   listTasks()            (all tasks with status summary)
 *   updateTask(id, ...)    (update description / metadata)
 *   stopTask(id)           (kill the process)
 *   waitForTask(id, ms)    (block until done or timeout)
 *
 * Each task runs as a child_process spawned with shell:true. Output
 * (stdout+stderr) is accumulated in-memory (capped) and optionally
 * persisted to sessionDir for large outputs.
 */

import { type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { writeFileSync, mkdirSync, appendFileSync, renameSync } from 'fs'
import { join } from 'path'
import { registerPhysicalResource, spawnManaged, type ExecutionProfile } from './executionBackend.js'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { captureOwnedProcessTree, stopOwnedProcessTree, type OwnedProcessTree } from './processTree.js'
import { StringDecoder } from 'string_decoder'

function getShellInvocation(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/c', command] }
  }
  return { shell: process.env.SHELL || '/bin/bash', args: ['-lc', command] }
}

// ── Types ───────────────────────────────────────────────────────────────────

export type TaskStatus = 'running' | 'stopping' | 'stop_failed' | 'completed' | 'failed' | 'stopped'

/** Public task info — safe to return to tools (no internal process handle). */
export interface TaskInfo {
  id: string
  command: string
  description: string
  status: TaskStatus
  exitCode: number | null
  pid: number | null
  startTime: number
  endTime: number | null
  durationMs: number | null
  outputLength: number
  metadata: Record<string, unknown>
}

/** Task detail — includes accumulated output. */
export interface TaskDetail extends TaskInfo {
  output: string
}

interface InternalTask {
  info: TaskInfo
  process: ChildProcess | null
  output: string
  outputFile: string | null
  /** True after stopTask() — prevents close handler from overriding status */
  stopped: boolean
  /** Total bytes received across the lifetime of the task (UTF-8 byte count). */
  totalOutputBytes: number
  /**
   * Bytes written to the CURRENT on-disk log file since the last rotation
   * (UTF-8 byte count). Independent of stat() timing — incremented by
   * the append, used as the rotation trigger. After rotation this resets
   * to 0 and a fresh empty log file is created.
   */
  currentFileBytes: number
  /**
   * Pending SIGKILL escalation timer for this task. Cleared by the
   * close/error handler as soon as the process exits so we never
   * double-signal. Owned by the task — duplicate stopTask() calls reuse
   * the same timer slot rather than scheduling a new one.
   */
  killTimer: NodeJS.Timeout | null
  identity: Promise<ProcessIdentity | null>
  stopPromise?: Promise<void>
  onSettled: () => void
}

// ── Constants ───────────────────────────────────────────────────────────────

const MAX_OUTPUT_BUFFER = 200_000 // 200KB in-memory cap; rest goes to file
const MAX_OUTPUT_RETURN = 30_000  // 30KB cap when returning to LLM context
const DEFAULT_MAX_OUTPUT_FILE_BYTES = 10 * 1024 * 1024 // 10MB per-task log rotation cap
const DEFAULT_SIGKILL_GRACE_MS = 3000     // grace period before SIGKILL escalation

// ── Process-tree helpers ────────────────────────────────────────────────────

/**
 * Kill the entire process tree rooted at `pid`.
 *
 * - POSIX: relies on `detached: true` so the child became its own
 *   process-group leader; a negative PID signals every member.
 * - Windows: shells out to `taskkill /T /F /PID` which recursively
 *   terminates the process AND its children. `process.kill(-pid)` does
 *   NOT exist on Windows.
 *
 * IMPORTANT: this does NOT set ChildProcess.killed (which only flips when
 * Node's own ChildProcess.kill() is called, not when we use the lower-level
 * process.kill()). Callers must NOT rely on `proc.killed` to decide whether
 * the escalation timer should fire — they must check the InternalTask's
 * `killTimer` slot and clear it from the close/error handler.
 */
function stopInternal(task: InternalTask, graceMs: number): boolean {
  const proc = task.process
  if (!proc || task.stopped) return false
  task.stopped = true
  task.info.status = 'stopping'
  task.stopPromise = (async () => {
    try {
      const identity = await task.identity
      if (!identity) {
        if (proc.exitCode === null && proc.signalCode === null) throw new Error('Process birth identity unavailable; termination cannot be verified')
      } else {
        let tree: OwnedProcessTree
        if (await inspectProcessIdentity(identity) === 'matching') tree = await captureOwnedProcessTree(identity)
        else throw new Error('Task root exited before descendant discovery; resources require recovery')
        const result = await stopOwnedProcessTree(tree, graceMs)
        if (!result.stopped) throw new Error(result.reason ?? 'Process tree stop failed')
      }
      task.info.status = 'stopped'
      task.info.exitCode = proc.exitCode
      task.info.endTime = Date.now()
      task.info.durationMs = task.info.endTime - task.info.startTime
      task.onSettled()
    } catch (error) {
      task.info.status = 'stop_failed'
      task.info.metadata.stopError = error instanceof Error ? error.message : String(error)
    }
  })()
  return true
}
// ── Manager ─────────────────────────────────────────────────────────────────

/** Manager-level configuration knobs. Tests use these to make timing
 *  assertions fast and rotation tests small. */
export interface BackgroundTaskManagerOptions {
  /** SIGTERM → SIGKILL grace window. Default 3000ms. */
  sigkillGraceMs?: number
  /** Per-task log file rotation cap. Default 10MB. */
  maxOutputFileBytes?: number
}

export class BackgroundTaskManager {
  private tasks = new Map<string, InternalTask>()
  private readonly sigkillGraceMs: number
  private readonly maxOutputFileBytes: number

  constructor(options: BackgroundTaskManagerOptions = {}) {
    // Validate sigkillGraceMs: must be a finite non-negative integer.
    // NaN, Infinity, negative, fractional, or non-number values fall
    // back to the default. 0 is allowed (immediate SIGKILL escalation).
    if (
      typeof options.sigkillGraceMs === 'number' &&
      Number.isFinite(options.sigkillGraceMs) &&
      Number.isInteger(options.sigkillGraceMs) &&
      options.sigkillGraceMs >= 0
    ) {
      this.sigkillGraceMs = options.sigkillGraceMs
    } else {
      this.sigkillGraceMs = DEFAULT_SIGKILL_GRACE_MS
    }
    // Validate maxOutputFileBytes: must be a finite POSITIVE integer
    // (0 or negative would disable rotation, which is a footgun — if
    // you genuinely want no rotation, do it explicitly elsewhere).
    if (
      typeof options.maxOutputFileBytes === 'number' &&
      Number.isFinite(options.maxOutputFileBytes) &&
      Number.isInteger(options.maxOutputFileBytes) &&
      options.maxOutputFileBytes > 0
    ) {
      this.maxOutputFileBytes = options.maxOutputFileBytes
    } else {
      this.maxOutputFileBytes = DEFAULT_MAX_OUTPUT_FILE_BYTES
    }
  }

  /**
   * Spawn a background command. Returns the task ID immediately.
   * The process runs detached; output is accumulated asynchronously.
   *
   * `options.signal` (AbortSignal, optional) — when supplied, an abort
   * stops the running task with SIGTERM (the manager's normal escalation
   * policy applies). The listener is removed the moment the task closes
   * so a fired signal can't keep a dangling listener alive, and a
   * pre-aborted signal triggers an immediate pre-abort stop instead of
   * spawning a child at all.
   */
  createTask(
    command: string,
    options?: {
      description?: string
      cwd?: string
      sessionDir?: string
      metadata?: Record<string, unknown>
      signal?: AbortSignal
      onSettled?: () => void
      profile?: ExecutionProfile
    },
  ): string {
    let releasePhysical!: () => void
    const physical = new Promise<void>(resolve => { releasePhysical = resolve })
    let settled = false
    const onSettled = (): void => {
      if (settled) return
      settled = true
      releasePhysical()
      options?.onSettled?.()
    }
    const id = `task_${randomUUID().slice(0, 8)}`
    const now = Date.now()

    const info: TaskInfo = {
      id,
      command,
      description: options?.description ?? command,
      status: 'running',
      exitCode: null,
      pid: null,
      startTime: now,
      endTime: null,
      durationMs: null,
      outputLength: 0,
      metadata: options?.metadata ?? {},
    }

    // Optional: persist output to file for large outputs
    let outputFile: string | null = null
    if (options?.sessionDir) {
      try {
        const dir = join(options.sessionDir, 'task-outputs')
        mkdirSync(dir, { recursive: true })
        outputFile = join(dir, `${id}.log`)
        writeFileSync(outputFile, '', 'utf8')
      } catch {
        outputFile = null
      }
    }

    if (this.tasks.size >= 256) throw new Error('Background task capacity exceeded; clear completed tasks before starting more')
    const task: InternalTask = { info, process: null, output: '', outputFile, stopped: false, totalOutputBytes: 0, currentFileBytes: 0, killTimer: null, identity: Promise.resolve(null), onSettled }

    /** Rotate the on-disk log: rename current → .log.1, recreate empty log.
     *  Only resets currentFileBytes if the rename actually succeeded —
     *  otherwise our byte counter would lie about on-disk state. */
    const rotateFile = (): void => {
      if (!outputFile) return
      const rotated = `${outputFile}.1`
      let renamed = false
      try {
        renameSync(outputFile, rotated)
        renamed = true
      } catch {
        /* rename failed (e.g. cross-device, perm) — original file is
         * still at outputFile; DO NOT truncate it, the append path will
         * keep working against the existing bytes. */
      }
      if (renamed) {
        // Recreate an empty file at the original path so getOutputFile()
        // never points to a missing file. Truncate-and-create is safe here
        // because rename just moved the original content to .1.
        try {
          writeFileSync(outputFile, '', 'utf8')
        } catch {
          /* best-effort */
        }
        task.currentFileBytes = 0
      }
    }

    const appendOutput = (data: string): void => {
      // UTF-8 byte length of the appended chunk — NOT string length.
      // For ASCII these are equal, but multibyte (CJK, emoji) chars
      // expand to multiple bytes and we want disk-bound accounting.
      const chunkBytes = Buffer.byteLength(data, 'utf8')
      task.totalOutputBytes += chunkBytes
      info.outputLength = task.totalOutputBytes
      task.output += data
      // Cap in-memory buffer; keep the tail (most recent output).
      if (task.output.length > MAX_OUTPUT_BUFFER) {
        task.output = task.output.slice(-MAX_OUTPUT_BUFFER)
      }
      // Persist to file if available. Rotation is driven by the
      // deterministic byte counter (task.currentFileBytes) — we do NOT
      // call statSync() after the append because its result depends on
      // filesystem-flush timing and is unreliable under heavy load or
      // small chunks. The counter is incremented BEFORE the append
      // check so we always rotate as soon as the threshold is crossed,
      // even across multiple appends in quick succession.
      if (outputFile) {
        // Pre-append check: if adding this chunk would push us over
        // the cap, rotate first so the new chunk lands in a fresh file.
        if (task.currentFileBytes + chunkBytes > this.maxOutputFileBytes && task.currentFileBytes > 0) {
          rotateFile()
        }
        try {
          appendFileSync(outputFile, data, 'utf8')
          task.currentFileBytes += chunkBytes
        } catch {
          /* best-effort */
        }
        // Post-append safety net: if the post-append file somehow
        // grew past the cap despite the pre-check (e.g. concurrent
        // writers, filesystem-level buffering), rotate anyway. The
        // `task.currentFileBytes > 0` guard prevents a redundant
        // rotation on an already-empty file.
        if (task.currentFileBytes > this.maxOutputFileBytes && task.currentFileBytes > 0) {
          rotateFile()
        }
      }
    }

    // Pre-aborted signal: don't bother spawning at all. Return the
    // task id so callers can still reference it, but mark it stopped
    // with no actual process. This avoids a wasted fork + immediate-
    // kill path that would otherwise leave a zombie until SIGKILL
    // escalation finishes.
    if (options?.signal?.aborted) {
      this.tasks.set(id, task)
      info.status = 'stopped'
      info.endTime = info.startTime
      info.durationMs = 0
      info.exitCode = -1
      task.stopped = true
      onSettled()
      return id
    }

    // Spawn the process. On POSIX, detached:true makes the child its own
    // process-group leader, which lets us deliver SIGTERM/SIGKILL to every
    // grandchild (e.g. backgrounded `sleep 30 &`) via process.kill(-pid).
    // Windows has no process-group primitive, so we leave detached=false
    // there — killProcessTree() falls back to a single-PID signal.
    const invocation = getShellInvocation(command)
    const proc = spawnManaged(invocation.shell, invocation.args, {
      cwd: options?.cwd,
      detached: process.platform !== 'win32',
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: process.platform === 'win32',
      profile: options?.profile,
    })
    registerPhysicalResource(physical)

    task.process = proc
    info.pid = proc.pid ?? null
    task.identity = proc.pid ? captureProcessIdentity(proc.pid) : Promise.resolve(null)

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    proc.stdout?.on('data', (data: Buffer) => appendOutput(stdoutDecoder.write(data)))
    proc.stderr?.on('data', (data: Buffer) => appendOutput(stderrDecoder.write(data)))

    // Wire the abort signal so an outer cancel stops the task cleanly.
    // The listener is removed the moment the process exits — see the
    // close handler below. Without this, a stopTask via signal would
    // never fire because detached children live independently of the
    // parent's signal-listener bookkeeping.
    let signalListener: (() => void) | null = null
    if (options?.signal) {
      signalListener = () => {
        stopInternal(task, this.sigkillGraceMs)
      }
      options.signal.addEventListener('abort', signalListener, { once: true })
    }
    const removeSignalListener = () => {
      if (signalListener && options?.signal) {
        try {
          options.signal.removeEventListener('abort', signalListener)
        } catch { /* signal may already be GC'd — best-effort */ }
        signalListener = null
      }
    }

    proc.on('close', (code: number | null) => {
      appendOutput(stdoutDecoder.end())
      appendOutput(stderrDecoder.end())
      if (!task.stopped) onSettled()
      // Process has exited. Always clear timer + null the handle FIRST,
      // so the escalation callback (if it races us) sees task.process
      // !== proc and bails out. Only THEN decide whether to override
      // the status — if the task was already marked stopped by a
      // manual stopTask(), leave the status as 'stopped'.
      removeSignalListener()
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = null
      }
      task.process = null
      if (task.stopped) return
      if (info.status !== 'running') return
      info.exitCode = code
      info.status = code === 0 ? 'completed' : 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
    })

    proc.on('error', (err: Error & { code?: string }) => {
      if (proc.pid === undefined) onSettled()
      // Same reasoning as 'close': process is gone (or never came up).
      // Always clean up the timer + handle first.
      removeSignalListener()
      if (task.killTimer) {
        clearTimeout(task.killTimer)
        task.killTimer = null
      }
      appendOutput(`\n[Process error: ${err.message}]\n`)
      task.process = null
      if (task.stopped) return
      if (info.status !== 'running') return
      info.exitCode = -1
      info.status = 'failed'
      info.endTime = Date.now()
      info.durationMs = info.endTime - info.startTime
    })

    this.tasks.set(id, task)
    return id
  }

  /** Get basic task info (no output). */
  getTask(id: string): TaskInfo | undefined {
    const task = this.tasks.get(id)
    return task ? { ...task.info } : undefined
  }

  /**
   * Get task detail including output.
   * @param outputPreview  Max chars of output to return (default 30_000)
   */
  getTaskDetail(id: string, outputPreview = MAX_OUTPUT_RETURN): TaskDetail | undefined {
    const task = this.tasks.get(id)
    if (!task) return undefined
    const output = task.output.length > outputPreview
      ? task.output.slice(-outputPreview) +
        `\n\n[... output truncated: showing last ${outputPreview} of ${task.info.outputLength} chars ...]`
      : task.output
    return { ...task.info, output }
  }

  /** List all tasks (newest first). */
  listTasks(): TaskInfo[] {
    return Array.from(this.tasks.values())
      .map((t) => ({ ...t.info }))
      .sort((a, b) => b.startTime - a.startTime)
  }

  /** Update a task's description and/or metadata. Returns false if not found. */
  updateTask(
    id: string,
    updates: { description?: string; metadata?: Record<string, unknown> },
  ): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    if (updates.description !== undefined) {
      task.info.description = updates.description
    }
    if (updates.metadata !== undefined) {
      task.info.metadata = { ...task.info.metadata, ...updates.metadata }
    }
    return true
  }

  /** Stop a running task. Returns true if the task was running and was killed. */
  stopTask(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    return stopInternal(task, this.sigkillGraceMs)
  }

  /**
   * Tear down the manager. Signals SIGTERM on every running task so the
   * close handlers fire and clean up their own timers + process handles,
   * then clears the in-memory task map. Intended to be called on engine
   * shutdown so background tasks don't outlive the host process.
   * Idempotent — safe to call multiple times.
   *
   * Note: this does NOT remove listeners from the underlying ChildProcess
   * streams — Node owns those and they will be GC'd when the process is
   * reaped. What it DOES clear is the manager's task map. The escalation
   * timer callback (firing after the grace window, if the process is
   * still alive) holds the InternalTask via closure, so removing the map
   * entry does NOT cancel the escalation — the timer self-cancels via
   * the close handler when the SIGTERM'd process exits.
   */
  async dispose(): Promise<void> {
    for (const [, task] of Array.from(this.tasks.entries())) {
      if (task.info.status === 'running') {
        stopInternal(task, this.sigkillGraceMs)
      }
    }
    await Promise.all([...this.tasks.values()].map(task => task.stopPromise ?? Promise.resolve()))
    const failed = [...this.tasks.values()].filter(task => task.info.status === 'stop_failed')
    if (failed.length) throw new Error(`Background process termination unconfirmed: ${failed.map(task => task.info.id).join(', ')}`)
    this.tasks.clear()
  }

  /**
   * Wait for a task to complete (or timeout). Polls every 100ms.
   * Returns the final TaskInfo, or null if the task doesn't exist.
   */
  async waitForTask(id: string, timeoutMs = 30_000): Promise<TaskInfo | null> {
    const task = this.tasks.get(id)
    if (!task) return null
    if (!['running', 'stopping'].includes(task.info.status)) return { ...task.info }

    const deadline = Date.now() + timeoutMs
    return new Promise((resolve) => {
      const poll = (): void => {
        const t = this.tasks.get(id)
        if (!t) {
          resolve(null)
          return
        }
        if (!['running', 'stopping'].includes(t.info.status) || Date.now() >= deadline) {
          resolve({ ...t.info })
          return
        }
        setTimeout(poll, 100)
      }
      poll()
    })
  }

  /** Remove completed/failed/stopped tasks from memory. Returns count removed. */
  clearCompleted(): number {
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (!['running', 'stopping', 'stop_failed'].includes(task.info.status)) {
        this.tasks.delete(id)
        removed++
      }
    }
    return removed
  }

  /** Get the output file path for a task (if sessionDir was provided). */
  getOutputFile(id: string): string | null {
    const task = this.tasks.get(id)
    return task?.outputFile ?? null
  }
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** Format a task list as a readable string for tool results. */
export function formatTaskList(tasks: TaskInfo[]): string {
  if (tasks.length === 0) return 'No background tasks.'
  const lines = tasks.map((t) => {
    const statusIcon =
      t.status === 'running' ? '◆' :
      t.status === 'completed' ? '✓' :
      t.status === 'failed' ? '✗' : '⊙'
    const duration = t.durationMs !== null ? ` (${(t.durationMs / 1000).toFixed(1)}s)` : ''
    const exit = t.exitCode !== null && t.exitCode !== 0 ? ` exit=${t.exitCode}` : ''
    return `${statusIcon} ${t.id} [${t.status}]${duration}${exit} ${t.description}`
  })
  return lines.join('\n')
}

/** Format a single task detail for tool results. */
export function formatTaskDetail(detail: TaskDetail): string {
  const lines = [
    `Task ${detail.id}: ${detail.description}`,
    `Status: ${detail.status}` +
      (detail.exitCode !== null ? ` (exit code: ${detail.exitCode})` : ''),
    `Command: ${detail.command}`,
    `Started: ${new Date(detail.startTime).toISOString()}`,
  ]
  if (detail.endTime) {
    lines.push(`Ended: ${new Date(detail.endTime).toISOString()}`)
    lines.push(`Duration: ${(detail.durationMs! / 1000).toFixed(1)}s`)
  } else {
    lines.push('Duration: (still running)')
  }
  if (detail.pid) lines.push(`PID: ${detail.pid}`)
  lines.push(`Output (${detail.outputLength} chars):`)
  lines.push(detail.output || '(no output yet)')
  return lines.join('\n')
}
