/**
 * BashTool — shell command execution with proper abort + process-group cleanup.
 *
 * Linux/macOS: child is spawned with `detached: true` so it becomes the
 * leader of its own process group; `process.kill(-pid, SIGTERM)` then
 * signals the entire subtree (shell + every backgrounded `&` subprocess).
 * Windows: falls back to `taskkill /F /T /PID` (tree kill).
 *
 * Output / timeout / hint contracts are unchanged from the previous
 * `exec()`-based implementation so callers and existing tests behave the
 * same way; only the abort path and cleanup guarantees are tightened.
 *
 * Cleanup state machines — promise lifecycle vs process lifecycle:
 *
 *   promise lifecycle  (settled / resolve)
 *     ↳ resolves the outer Promise<ToolResult>
 *     ↳ removes the abort listener
 *     ↳ fires follow-mode cleanup
 *     ↳ does NOT clear SIGKILL escalation (process may still be alive)
 *
 *   process lifecycle  (timeoutTimer / killTimer)
 *     ↳ timeoutTimer cleared on EVERY terminal path (close / error /
 *       abort / timeout-fire) so it can never double-fire after abort
 *     ↳ killTimer cleared only on child close / error so the SIGKILL
 *       escalation actually fires if SIGTERM is ignored by a stubborn
 *       child (otherwise clearing it in settle would silently leak the
 *       whole subprocess tree)
 */

import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { BASH_DESCRIPTION } from '../prompts/tools.js'
import { mkdirSync, accessSync, constants } from 'fs'
import { join } from 'path'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 1_800_000  // 30 min — long-running commands default
const MAX_TIMEOUT_MS = 14_400_000    // 4 h — max for very long tasks
const DEFAULT_SIGKILL_GRACE_MS = 5_000

// Shell detection — prioritize user override, then platform default.
// On Windows: prefer Git Bash if available, fall back to cmd.exe.
// Claude Code approach: use the system's native shell, don't force bash.
function detectShell(): string {
  if (process.env.OVOGO_SHELL) return process.env.OVOGO_SHELL
  if (process.platform === 'win32') {
    // Try Git Bash (common on Windows dev machines)
    const gitBashPaths = [
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ]
    for (const p of gitBashPaths) {
      try { accessSync(p, constants.X_OK); return p } catch { /* not found */ }
    }
    // Fall back to cmd.exe — always available on Windows
    return process.env.ComSpec || 'cmd.exe'
  }
  return '/bin/bash'
}
const SHELL = detectShell()
const IS_WIN_CMD = SHELL.endsWith('cmd.exe')

export interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  description?: string
  follow_mode?: boolean   // Stream output to user's tmux pane for spectator view
}

function truncateOutput(output: string, maxLen: number): string {
  if (output.length <= maxLen) return output
  const half = Math.floor(maxLen / 2)
  const head = output.slice(0, half)
  const tail = output.slice(output.length - half)
  return `${head}\n\n[... ${output.length - maxLen} characters truncated ...]\n\n${tail}`
}

/** Build the diagnostic hint appended to a non-zero-exit error message. */
function buildErrorHint(out: string): string {
  const lowerOut = out.toLowerCase()
  if (lowerOut.includes('command not found')) {
    return '\n\n[Hint: command not found — check if the tool is installed or in PATH. Try `which <cmd>` or install it.]'
  }
  if (lowerOut.includes('no such file or directory')) {
    return '\n\n[Hint: file/directory not found — check the path. Use Glob to find the correct location.]'
  }
  if (lowerOut.includes('permission denied')) {
    return '\n\n[Hint: permission denied — check file permissions or try with appropriate privileges.]'
  }
  if (lowerOut.includes('econnrefused') || lowerOut.includes('etimedout')) {
    return '\n\n[Hint: connection error — check if the service is running and the port is correct.]'
  }
  if (lowerOut.includes('cannot find module') || lowerOut.includes('could not resolve')) {
    return '\n\n[Hint: module not found — run `npm install` or check the import path.]'
  }
  if (lowerOut.includes('syntax error') || lowerOut.includes('unexpected token')) {
    return '\n\n[Hint: syntax error — check for missing brackets, semicolons, or incorrect syntax.]'
  }
  return ''
}

/**
 * Normalise a user-supplied SIGKILL grace value. Returns the default
 * for any non-finite or negative input so a misconfigured constructor
 * argument can never disable SIGKILL escalation (e.g. `NaN` or `-1`
 * would otherwise pass through `setTimeout` and never fire).
 */
function normaliseGraceMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_SIGKILL_GRACE_MS
  }
  return value
}

/**
 * Optional BashTool configuration.
 *
 * `sigkillGraceMs` — wall-clock delay between SIGTERM (polite kill) and
 * SIGKILL (forced kill) when aborting / timing out a command. Default
 * 5 000 ms. Pass a smaller value in tests to exercise the SIGKILL
 * branch without sleeping for the production grace period.
 */
export interface BashToolOptions {
  sigkillGraceMs?: number
}

export class BashTool implements Tool {
  name = 'Bash'
  metadata = {
    concurrencySafe: false,
    longRunning: true,
    mutatesState: true,
  }

  /** Wall-clock delay between SIGTERM and SIGKILL escalation. */
  private readonly sigkillGraceMs: number

  constructor(options: BashToolOptions = {}) {
    this.sigkillGraceMs = normaliseGraceMs(options.sigkillGraceMs)
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Bash',
      description: BASH_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'The bash command to execute',
          },
          timeout: {
            type: 'number',
            description: `Timeout in milliseconds. Default: ${DEFAULT_TIMEOUT_MS} (30 min). Max: ${MAX_TIMEOUT_MS} (4 h). For long-running commands, prefer run_in_background:true instead of raising timeout.`,
          },
          run_in_background: {
            type: 'boolean',
            description: 'Run command in background and return immediately',
          },
          description: {
            type: 'string',
            description: 'Brief description of what this command does (shown to user)',
          },
          follow_mode: {
            type: 'boolean',
            description: 'If true, stream output to a tmux pane for real-time user viewing (spectator mode). The LLM still receives the full output after completion.',
          },
        },
        required: ['command'],
      },
    },
  }

  /**
   * Per-input concurrency check (Claude Code pattern).
   * Read-only / query commands are safe to parallelize.
   * Mutating commands (install, build, write, git push) are NOT safe.
   *
   * Order matters: shell control operators (`&&`, `||`, `;`, `|`) and
   * any unsafe-mutating pattern are checked BEFORE the safe read-only
   * patterns. Otherwise a chained `ls && rm foo` would match the
   * read-only `ls` pattern first and be classified as safe, even
   * though the trailing `rm` makes the whole command unsafe.
   */
  isConcurrencySafe(input: Record<string, unknown>): boolean {
    const command = typeof input.command === 'string' ? input.command.toLowerCase() : ''
    if (!command) return false

    // Background commands still run the pattern check below — two parallel
    // `npm install` in background will corrupt node_modules just the same.

    // Step 1: any shell control operator makes the command non-safe.
    // We can't reason about what each side does without parsing, so
    // refuse to parallelize anything that chains multiple commands.
    if (/(\|\||&&|;|\|)/.test(command)) return false

    // Step 2: explicit unsafe mutating patterns win next — a `rm` is
    // a `rm` regardless of how it's framed.
    const unsafePatterns = [
      /^(npm\s+(install|i|ci|uninstall|rm|publish)\b)/,
      /^(pnpm\s+(install|add|remove|rm)\b)/,
      /^(yarn\s+(add|remove|install)\b)/,
      /^(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick)\b)/,
      /^(rm\s|mv\s|cp\s|mkdir\s|rmdir\s|chmod\s|chown\s)/,
      /^(curl\s|wget\s)/,
      /^(docker\s|kubectl\s|terraform\s)/,
      /^(npm\s+run\s|pnpm\s+run\s|yarn\s)/,
    ]
    for (const pattern of unsafePatterns) {
      if (pattern.test(command)) return false
    }

    // Step 3: explicit safe read-only patterns.
    const safePatterns = [
      /^(ls|cat|head|tail|echo|pwd|whoami|date|which|whereis|file)\b/,
      /^(git\s+(status|log|diff|branch|show|blame|remote|rev-parse|config\s+--get)\b)/,
      /^(grep|rg|find|fd)\b/,
      /^(npm\s+(list|ls|view|info|outdated)\b)/,
      /^(pnpm\s+(list|ls|why)\b)/,
      /^(node\s+--version|npm\s+--version|pnpm\s+--version|npx\s+--version)/,
      /^(npx\s+tsc\s+--noemit)/,
      /^(npx\s+eslint\s+.*--check)/,
      /^(npx\s+prettier\s+.*--check)/,
      /^(test\s|-d\s|-f\s|-e\s)/,
    ]
    for (const pattern of safePatterns) {
      if (pattern.test(command)) return true
    }

    // Default: conservative — treat unknown commands as unsafe
    return false
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background, description, follow_mode } = input as unknown as BashInput

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true }
    }

    const timeoutMs = Math.min(
      typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── Background mode (fire-and-forget with auto log redirect) ─────────────
    if (run_in_background) {
      if (context.backgroundTaskManager) {
        const id = context.backgroundTaskManager.createTask(command, {
          description,
          cwd: context.cwd,
          sessionDir: context.sessionDir,
          metadata: { source: 'Bash.run_in_background' },
        })
        const task = context.backgroundTaskManager.getTask(id)
        return {
          content: `Background task created: ${id}\nCommand: ${command}\nPID: ${task?.pid ?? 'unknown'}\nStatus: running\n\nUse TaskGet with task_id="${id}" or /tasks to check status and output.`,
          isError: false,
        }
      }

      // Auto-redirect stdout/stderr to a session-scoped log file so output
      // is never lost even if the caller forgets to add `> file 2>&1`.
      const bgLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
      try { mkdirSync(bgLogDir, { recursive: true }) } catch { /* best-effort */ }

      const ts = Date.now()
      const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const logFile = join(bgLogDir, `${ts}_${safeCmd}_${Math.random().toString(36).slice(2, 6)}.log`)

      // Append redirect if the caller didn't already redirect
      const alreadyRedirected = command.includes('>') || command.includes('2>&1') || command.includes('/dev/null')
      const actualCommand = alreadyRedirected ? command : `${command} >> "${logFile}" 2>&1`

      // Use appropriate shell flags: bash uses -c, cmd.exe uses /c
      const shellArgs = IS_WIN_CMD ? ['/c', actualCommand] : ['-c', actualCommand]
      let child: ChildProcess
      try {
        // Background mode: detached + own process group. unref() so the
        // foreground REPL can exit without waiting on every fire-and-forget
        // task the model ever spawned.
        child = spawn(SHELL, shellArgs, {
          cwd: context.cwd,
          env: process.env,
          detached: true,
          stdio: 'ignore',
        })
      } catch (e) {
        return { content: `Failed to start background command: ${(e as Error).message}`, isError: true }
      }
      // Prevent ENOENT crash — spawn emits async 'error' if shell binary is missing
      child.on('error', () => {})
      child.unref()

      const redirectInfo = alreadyRedirected ? '' : `\nOutput redirected to: ${logFile}`
      return {
        content: `Command started in background (PID: ${child.pid})${redirectInfo}`,
        isError: false,
      }
    }

    // ── Foreground mode with abort support ──────────────────────
    return this.runForeground(command, timeoutMs, follow_mode, context)
  }

  /**
   * Run a foreground command, returning once it exits or is cancelled.
   *
   * Contract (unchanged from the previous `exec()`-based implementation):
   *  - exit code 0          → isError=false, content = stdout/stderr
   *  - non-zero exit code   → isError=false, content = "Exit code: N\n..."
   *  - internal timeout     → isError=true, content = "Command timed out..."
   *  - abort signal         → isError=true, content = "Command cancelled..."
   *  - pre-abort            → isError=true, content = "Command cancelled (pre-abort)."
   *
   * New guarantees:
   *  - pre-abort short-circuits before spawning
   *  - abort kills the entire process group (Unix) / process tree (Windows)
   *  - SIGKILL escalation survives promise resolution — fires on a
   *    SIGTERM-ignoring child even after the cancel result was returned
   *  - timeout timer is cleared on every terminal path so abort cannot
   *    be followed by a spurious timeout
   *  - abort listener is removed the moment the promise settles
   */
  private runForeground(
    command: string,
    timeoutMs: number,
    followMode: boolean | undefined,
    context: ToolContext,
  ): Promise<ToolResult> {
    // Pre-abort: if the signal is already aborted, refuse to spawn the
    // process at all. Returning a plain cancelled result here avoids the
    // wasted fork + immediate-kill path.
    if (context.signal?.aborted) {
      return Promise.resolve({
        content: 'Command cancelled (pre-abort).',
        isError: true,
      })
    }

    return new Promise<ToolResult>((resolve) => {
      // Promise-lifecycle state
      let settled = false
      // Abort listener — tracked so we can remove it the moment the
      // promise settles (avoids the listener firing on a dead signal).
      let abortListener: (() => void) | null = null

      // Process-lifecycle state — these outlive the promise.
      let timeoutTimer: NodeJS.Timeout | null = null
      let killTimer: NodeJS.Timeout | null = null
      // Set when the internal timeout fires so the child.on('close')
      // handler can route to the timeout contract rather than reporting
      // a fresh non-zero exit.
      let timedOut = false

      // follow-mode cleanup — fired on settle, NOT on child close
      let followCleanup: (() => void) | null = null

      // ── follow_mode: set up tmux spectator pane ───────────────
      let actualCommand = command
      let followModeHint = ''
      if (followMode) {
        const followLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
        try { mkdirSync(followLogDir, { recursive: true }) } catch { /* best-effort */ }
        const ts = Date.now()
        const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const followLogFile = join(followLogDir, `${ts}_${safeCmd}_follow.log`)

        // Wrap command: tee duplicates output so the LLM captures it AND the follow log gets it
        // Use platform-appropriate syntax
        if (IS_WIN_CMD) {
          actualCommand = `${command} 1>"${followLogFile}" 2>&1`
        } else {
          actualCommand = `{ ${command}; } 2>&1 | tee -a "${followLogFile}"`
        }

        // Launch a tmux session with tail -f for user viewing
        const tmuxSessionName = `ovogo-follow-${ts}`
        let paneJoined = false
        try {
          spawn('tmux', ['new-session', '-d', '-s', tmuxSessionName, '-x', '200', '-y', '50'], {
            cwd: context.cwd,
            detached: true,
          }).on('error', () => {})
          spawn('tmux', ['send-keys', '-t', tmuxSessionName, `tail -n +1 -f "${followLogFile}"`, 'Enter'], {
            cwd: context.cwd,
          }).on('error', () => {})
          // Try to join the follow pane into the user's current tmux window
          try {
            const currentTmux = process.env.TMUX_PANE ? process.env.TMUX?.split(',')[0]?.replace(/^\//, '') : null
            if (currentTmux) {
              spawn('tmux', ['join-pane', '-t', `${currentTmux}`, `-s`, `${tmuxSessionName}`, '-l', '15'], {
                cwd: context.cwd,
              }).on('error', () => {})
              paneJoined = true
            }
          } catch { /* best-effort: user can manually attach */ }

          followModeHint = paneJoined
            ? '[Spectator pane embedded in tmux]'
            : `[Spectator: tmux attach -t ${tmuxSessionName}]`

          followCleanup = () => {
            try { spawn('tmux', ['kill-session', '-t', tmuxSessionName], { detached: true }).on('error', () => {}) } catch { /* ignore */ }
          }
        } catch { /* tmux not available, degrade gracefully */ }
      }

      // Choose shell args based on platform
      const shellArgs = IS_WIN_CMD ? ['/c', actualCommand] : ['-c', actualCommand]

      // Spawn detached so the child is its own process group leader.
      // Then `process.kill(-pid, SIGTERM)` reaches the shell + every
      // backgrounded subprocess (the original exec()-based path missed
      // these because the child shared the parent's pgid).
      const child: ChildProcess = spawn(SHELL, shellArgs, {
        cwd: context.cwd,
        env: process.env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      // ── Output capture ────────────────────────────────────────
      let stdoutBuf = ''
      let stderrBuf = ''
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (d: string) => { stdoutBuf += d })
      child.stderr?.on('data', (d: string) => { stderrBuf += d })

      // ── Cleanup helpers ──────────────────────────────────────
      // settle() only resolves the promise + removes the listener +
      // runs follow cleanup. It does NOT touch the SIGKILL escalation
      // timer — that one is owned by the child lifecycle (close/error).
      const settle = (result: ToolResult) => {
        if (settled) return
        settled = true
        if (abortListener && context.signal) {
          context.signal.removeEventListener('abort', abortListener)
          abortListener = null
        }
        if (followCleanup) {
          try { followCleanup() } catch { /* best-effort */ }
          followCleanup = null
        }
        resolve(result)
      }
      const clearTimeoutTimer = () => {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
      }
      const clearKillTimer = () => {
        if (killTimer) {
          clearTimeout(killTimer)
          killTimer = null
        }
      }

      // ── Kill the entire process tree (Linux/macOS = process group,
      //    Windows = taskkill /T). Best-effort — swallow ESRCH etc. ──
      const killProcessTree = (signal: NodeJS.Signals) => {
        const pid = child.pid
        if (pid === undefined) return
        if (process.platform === 'win32') {
          try {
            execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 })
          } catch { /* best-effort */ }
          try { child.kill(signal) } catch { /* ignore */ }
        } else {
          // Negative pid = process group; valid because detached:true
          try { process.kill(-pid, signal) } catch { /* ESRCH if already gone */ }
        }
      }

      // ── Internal timeout (mirrors the previous exec() behaviour) ──
      timeoutTimer = setTimeout(() => {
        // Abort may have settled first — in that case the killTimer
        // already runs SIGTERM/SIGKILL escalation, so do nothing here.
        if (settled) return
        timedOut = true
        killProcessTree('SIGTERM')
        // Independent killTimer — only cleared when child actually dies
        // (in child.on('close') / 'error'). NOT cleared by settle().
        killTimer = setTimeout(() => {
          killTimer = null
          killProcessTree('SIGKILL')
        }, this.sigkillGraceMs)
        if (typeof killTimer.unref === 'function') killTimer.unref()
      }, timeoutMs)
      if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

      // ── Abort handler ─────────────────────────────────────────
      const onAbort = () => {
        if (settled) return
        killProcessTree('SIGTERM')
        // SIGKILL escalation timer — survives promise resolution.
        // Only child.on('close') / 'error' clears it, so a SIGTERM-
        // ignoring child is still guaranteed to die.
        killTimer = setTimeout(() => {
          killTimer = null
          killProcessTree('SIGKILL')
        }, this.sigkillGraceMs)
        if (typeof killTimer.unref === 'function') killTimer.unref()
        // clearTimeoutTimer is called inside child.on('close')/error;
        // but we also call it here so a slow-to-die child doesn't keep
        // the timeout scheduled. child.on('close') clears it again
        // (idempotent: clearTimeout(null) is a no-op).
        clearTimeoutTimer()
        const partialOut = [stdoutBuf, stderrBuf].filter(Boolean).join('\n').trimEnd()
        const partial = partialOut ? `\n\nPartial output before cancellation:\n${truncateOutput(partialOut, 5000)}` : ''
        settle({
          content: `Command cancelled (abort signal).${partial}\n\nHint: re-run with a smaller scope, or use run_in_background:true for long commands.`,
          isError: true,
        })
      }
      abortListener = onAbort
      context.signal?.addEventListener('abort', abortListener, { once: true })

      // ── Child error (e.g. ENOENT on the shell) ─────────────────
      child.on('error', (err) => {
        clearTimeoutTimer()
        clearKillTimer()
        if (settled) return
        settle({
          content: `Failed to start command: ${err.message}`,
          isError: true,
        })
      })

      // ── Child close: normal exit OR termination signal ──────────
      child.on('close', (code, signal) => {
        // Process is dead — clear every timer. settle() may have run
        // earlier (abort path); these are idempotent no-ops then.
        clearTimeoutTimer()
        clearKillTimer()
        if (settled) return

        const partialOut = [stdoutBuf, stderrBuf].filter(Boolean).join('\n').trimEnd()
        const prefix = followMode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''

        // Internal timeout fired the kill — child exits with non-zero
        // (or signal). Surface it as the timeout contract.
        if (timedOut) {
          const partial = partialOut ? `\n\nPartial output before timeout:\n${truncateOutput(partialOut, 5000)}` : ''
          settle({
            content: `Command timed out after ${timeoutMs / 1000}s.${partial}\n\nHint: for long-running commands, use run_in_background:true and check results with TaskGet, or raise the timeout argument.`,
            isError: true,
          })
          return
        }

        if (code === 0 && !signal) {
          const combined = partialOut || '(no output)'
          settle({
            content: truncateOutput(prefix + combined, MAX_OUTPUT_LENGTH),
            isError: false,
          })
          return
        }

        // Killed by an external signal (not via our timeout or abort).
        // Treat as a timeout-shaped error so callers see a useful message.
        if (signal === 'SIGTERM' || signal === 'SIGKILL') {
          const partial = partialOut ? `\n\nPartial output before timeout:\n${truncateOutput(partialOut, 5000)}` : ''
          settle({
            content: `Command timed out.${partial}\n\nHint: for long-running commands, use run_in_background:true and check results with TaskGet, or raise the timeout argument.`,
            isError: true,
          })
          return
        }

        // Non-zero exit — return stdout+stderr so the LLM can diagnose
        const exitCode = code ?? 1
        const out = partialOut
        const hint = buildErrorHint(out)
        settle({
          content: truncateOutput(prefix + `Exit code: ${exitCode}\n${out}${hint}`, MAX_OUTPUT_LENGTH).trimEnd(),
          isError: false,
        })
      })
    })
  }
}
