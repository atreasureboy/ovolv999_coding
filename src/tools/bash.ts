/**
 * BashTool — shell command execution with proper abort support
 *
 * Key change vs the previous promisified exec() approach:
 * We use exec() in callback form so we hold a reference to the ChildProcess.
 * When context.signal fires (Ctrl+C), we kill the entire process group
 * (SIGTERM → SIGKILL after 5 s)
 */

import { exec, spawn } from 'child_process'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { BASH_DESCRIPTION } from '../prompts/tools.js'
import { mkdirSync, accessSync, constants } from 'fs'
import { join } from 'path'

const MAX_OUTPUT_LENGTH = 30_000
const DEFAULT_TIMEOUT_MS = 1_800_000  // 30 min — long-running commands default
const MAX_TIMEOUT_MS = 14_400_000    // 4 h — max for very long tasks

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

export class BashTool implements Tool {
  name = 'Bash'

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
   */
  isConcurrencySafe(input: Record<string, unknown>): boolean {
    const command = typeof input.command === 'string' ? input.command.toLowerCase() : ''
    if (!command) return false

    // Background and follow-mode always safe (they don't block)
    if (input.run_in_background === true) return true

    // Safe: read-only commands
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

    // Unsafe: commands that modify state
    const unsafePatterns = [
      /^(npm\s+(install|i|ci|uninstall|rm|publish)\b)/,
      /^(pnpm\s+(install|add|remove|rm)\b)/,
      /^(yarn\s+(add|remove|install)\b)/,
      /^(git\s+(add|commit|push|pull|merge|rebase|reset|checkout|stash|cherry-pick)\b)/,
      /^(rm\s|mv\s|cp\s|mkdir\s|rmdir\s|chmod\s|chown\s)/,
      /^(curl\s|wget\s)/,
      /^(docker\s|kubectl\s|terraform\s)/,
      /^(npm\s+run\s|pnpm\s+run\s|yarn\s)/,
      /(\|\||&&|;)/,  // chained commands — can't guarantee safety
    ]
    for (const pattern of unsafePatterns) {
      if (pattern.test(command)) return false
    }

    // Default: conservative — treat unknown commands as unsafe
    return false
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const { command, timeout, run_in_background, follow_mode } = input as unknown as BashInput

    if (!command || typeof command !== 'string') {
      return { content: 'Error: command is required and must be a string', isError: true }
    }

    const timeoutMs = Math.min(
      typeof timeout === 'number' ? timeout : DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    )

    // ── Background mode (fire-and-forget with auto log redirect) ─────────────
    if (run_in_background) {
      // Auto-redirect stdout/stderr to a session-scoped log file so output
      // is never lost even if the caller forgets to add `> file 2>&1`.
      const bgLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
      try { mkdirSync(bgLogDir, { recursive: true }) } catch { /* best-effort */ }

      const ts = Date.now()
      const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
      const logFile = join(bgLogDir, `${ts}_${safeCmd}.log`)

      // Append redirect if the caller didn't already redirect
      const alreadyRedirected = command.includes('>') || command.includes('2>&1') || command.includes('/dev/null')
      const actualCommand = alreadyRedirected ? command : `${command} >> "${logFile}" 2>&1`

      // Use appropriate shell flags: bash uses -c, cmd.exe uses /c
      const shellArgs = IS_WIN_CMD ? ['/c', actualCommand] : ['-c', actualCommand]
      const child = spawn(SHELL, shellArgs, {
        cwd: context.cwd,
        env: process.env,
      })
      child.unref()

      const redirectInfo = alreadyRedirected ? '' : `\n输出自动重定向到: ${logFile}`
      return {
        content: `Command started in background (PID: ${child.pid})${redirectInfo}`,
        isError: false,
      }
    }

    // ── Foreground mode with abort support ──────────────────────
    // Use exec() callback form so we can kill the child on abort.
    // Kill by process group approach.
    return new Promise<ToolResult>((resolve) => {
      let settled = false

      // ── follow_mode: set up tmux spectator pane ───────────────
      let actualCommand = command
      let followCleanup: (() => void) | null = null
      let followModeHint = ''
      if (follow_mode) {
        const followLogDir = context.sessionDir ? join(context.sessionDir, '.bg_logs') : join(context.cwd, '.bg_logs')
        try { mkdirSync(followLogDir, { recursive: true }) } catch { /* best-effort */ }
        const ts = Date.now()
        const safeCmd = command.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
        const followLogFile = join(followLogDir, `${ts}_${safeCmd}_follow.log`)

        // Wrap command: tee duplicates output so the LLM captures it AND the follow log gets it
        actualCommand = `{ ${command}; } 2>&1 | tee -a "${followLogFile}"`

        // Launch a tmux session with tail -f for user viewing
        const tmuxSessionName = `ovogo-follow-${ts}`
        let paneJoined = false
        try {
          spawn('tmux', ['new-session', '-d', '-s', tmuxSessionName, '-x', '200', '-y', '50'], {
            cwd: context.cwd,
            detached: true,
          })
          spawn('tmux', ['send-keys', '-t', tmuxSessionName, `tail -n +1 -f "${followLogFile}"`, 'Enter'], {
            cwd: context.cwd,
          })
          // Try to join the follow pane into the user's current tmux window
          try {
            const currentTmux = process.env.TMUX_PANE ? process.env.TMUX?.split(',')[0]?.replace(/^\//, '') : null
            if (currentTmux) {
              spawn('tmux', ['join-pane', '-t', `${currentTmux}`, '-s', `${tmuxSessionName}`, '-l', '15'], {
                cwd: context.cwd,
              })
              paneJoined = true
            }
          } catch { /* best-effort: user can manually attach */ }

          followModeHint = paneJoined
            ? '[观战面板已嵌入当前 tmux 窗口底部]'
            : `[观战面板: tmux attach -t ${tmuxSessionName}]`

          followCleanup = () => {
            try { spawn('tmux', ['kill-session', '-t', tmuxSessionName], { detached: true }) } catch { /* ignore */ }
          }
        } catch { /* tmux not available, degrade gracefully */ }
      }

      const child = exec(
        actualCommand,
        {
          cwd: context.cwd,
          timeout: timeoutMs,
          maxBuffer: 50 * 1024 * 1024,
          env: { ...process.env, TERM: 'dumb' },
          shell: SHELL,
        },
        (err, stdout, stderr) => {
          // Remove the abort listener to prevent it firing after process ends
          if (context.signal) {
            context.signal.removeEventListener('abort', onAbort)
          }

          // Clean up follow mode resources
          if (followCleanup) {
            followCleanup()
          }

          if (settled) return
          settled = true

          // Check if we were cancelled
          if (context.signal?.aborted) {
            resolve({ content: 'Command cancelled.', isError: true })
            return
          }

          if (!err) {
            const combined = [stdout, stderr].filter(Boolean).join('\n').trimEnd()
            const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''
            resolve({ content: truncateOutput(prefix + combined, MAX_OUTPUT_LENGTH) || '(no output)', isError: false })
            return
          }

          const nodeErr = err as NodeJS.ErrnoException & {
            killed?: boolean
            signal?: string
            stdout?: string
            stderr?: string
            code?: number
          }

          if (nodeErr.killed || nodeErr.signal === 'SIGTERM') {
            resolve({ content: `Command timed out after ${timeoutMs / 1000}s`, isError: true })
            return
          }

          // Non-zero exit — provide stdout+stderr so the LLM can diagnose
          const out = [nodeErr.stdout ?? stdout, nodeErr.stderr ?? stderr].filter(Boolean).join('\n').trimEnd()
          const exitCode = nodeErr.code ?? 1
          const prefix = follow_mode ? `[Spectator mode: output streamed to tmux pane] ${followModeHint}\n` : ''

          // Error pattern detection — help the LLM diagnose common coding errors
          let hint = ''
          const lowerOut = out.toLowerCase()
          if (lowerOut.includes('command not found')) {
            hint = '\n\n[Hint: command not found — check if the tool is installed or in PATH. Try `which <cmd>` or install it.]'
          } else if (lowerOut.includes('no such file or directory')) {
            hint = '\n\n[Hint: file/directory not found — check the path. Use Glob to find the correct location.]'
          } else if (lowerOut.includes('permission denied')) {
            hint = '\n\n[Hint: permission denied — check file permissions or try with appropriate privileges.]'
          } else if (lowerOut.includes('econnrefused') || lowerOut.includes('etimedout')) {
            hint = '\n\n[Hint: connection error — check if the service is running and the port is correct.]'
          } else if (lowerOut.includes('cannot find module') || lowerOut.includes('could not resolve')) {
            hint = '\n\n[Hint: module not found — run `npm install` or check the import path.]'
          } else if (lowerOut.includes('syntax error') || lowerOut.includes('unexpected token')) {
            hint = '\n\n[Hint: syntax error — check for missing brackets, semicolons, or incorrect syntax.]'
          }

          resolve({
            content: truncateOutput(prefix + `Exit code: ${exitCode}\n${out}${hint}`, MAX_OUTPUT_LENGTH).trimEnd(),
            isError: false,  // non-zero exit is not necessarily fatal
          })
        },
      )

      // ── Abort handler — kill entire process group ────────────
      // Send SIGTERM to process group
      const onAbort = () => {
        if (settled) return
        settled = true

        const pid = child.pid
        if (pid !== undefined) {
          // Kill the process group (includes any subshells spawned by the command)
          try { process.kill(-pid, 'SIGTERM') } catch {
            try { child.kill('SIGTERM') } catch { /* ignore */ }
          }
          // SIGKILL fallback after 5 s for stubborn processes
          setTimeout(() => {
            try { process.kill(-pid, 'SIGKILL') } catch {
              try { child.kill('SIGKILL') } catch { /* ignore */ }
            }
          }, 5_000)
        }

        resolve({ content: 'Command cancelled.', isError: true })
      }

      if (context.signal) {
        if (context.signal.aborted) {
          onAbort()
        } else {
          context.signal.addEventListener('abort', onAbort, { once: true })
        }
      }
    })
  }
}
