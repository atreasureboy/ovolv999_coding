/**
 * HookRunner — executes configured shell hooks around tool calls
 *
 * Implements IHookRunner from core/types so the engine stays decoupled
 * from the config layer.
 *
 * Hooks are best-effort: failures NEVER throw, but they are no longer
 * silently swallowed. Each method returns a `HookResult[]` describing what
 * happened (success, non-zero exit, ENOENT, timeout, spawn failure). Callers
 * that want to react can pass an `onFailure` sink; tests can inspect the
 * returned array directly.
 *
 * Sensitive environment values (API keys, tokens, secrets) are scrubbed
 * from any error text we surface, so a misconfigured hook command cannot
 * leak credentials through logs.
 */

import { execSync } from 'child_process'
import type { HooksConfig, HookEntry } from './settings.js'
import type { HookErrorCode, HookResult, IHookRunner, TurnResult } from '../core/types.js'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_ENV_VALUE_LEN = 4096

/** Keys that look credential-ish — never echoed in error messages. */
const SENSITIVE_KEY_RE = /(api[_-]?key|access[_-]?token|secret|password|credential|private[_-]?key|auth[_-]?token)/i

function matchesHook(entry: HookEntry, toolName: string): boolean {
  if (!entry.matcher) return true
  const patterns = entry.matcher.split(',').map((s) => s.trim())
  return patterns.some((p) => {
    if (p === '*') return true
    if (p.endsWith('*')) return toolName.startsWith(p.slice(0, -1))
    return toolName === p
  })
}

/**
 * Strip any value that came from a sensitive env var from a free-form
 * string (typically the child process error message). Truncated long
 * values are skipped to avoid partial-match false positives.
 */
function redactEnv(text: string, env: Record<string, string>): string {
  let out = text
  for (const [key, value] of Object.entries(env)) {
    if (!SENSITIVE_KEY_RE.test(key)) continue
    if (!value || value.length < 8 || value.length > MAX_ENV_VALUE_LEN) continue
    out = out.split(value).join('[REDACTED]')
  }
  return out
}

function classifyError(err: unknown): { code: HookErrorCode; signal: NodeJS.Signals | null; status: number | null; message: string } {
  const e = err as { code?: string; signal?: NodeJS.Signals; status?: number | null; message?: string }
  const rawMessage = typeof e.message === 'string' ? e.message : String(err)
  let code: HookErrorCode = 'unknown'
  if (e.code === 'ENOENT') code = 'not_found'
  else if (e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM') code = 'timeout'
  else if (typeof e.status === 'number' && e.status !== 0) code = 'non_zero'
  else if (e.code) code = 'spawn_failed'
  return {
    code,
    signal: e.signal ?? null,
    status: typeof e.status === 'number' ? e.status : null,
    message: rawMessage,
  }
}

/**
 * Snapshot of sensitive values currently in process.env. Used to extend the
 * per-hook env when scrubbing error text so secrets that were already in the
 * environment (e.g. ANTHROPIC_API_KEY) cannot leak through exec error messages.
 */
function pickSensitiveFromProcessEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== 'string') continue
    if (!SENSITIVE_KEY_RE.test(key)) continue
    if (!value || value.length < 8 || value.length > MAX_ENV_VALUE_LEN) continue
    out[key] = value
  }
  return out
}

/**
 * Pluggable command runner. Defaults to `execSync` (synchronous shell exec).
 * Tests inject a fake to drive success / non-zero / ENOENT / timeout paths
 * without spawning real processes.
 */
export interface HookExecOptions {
  command: string
  env: Record<string, string>
  timeoutMs: number
}

export type HookCommandRunner = (options: HookExecOptions) => Pick<HookResult, 'ok' | 'status' | 'signal' | 'durationMs' | 'error' | 'errorCode'>

function defaultRunner(options: HookExecOptions): ReturnType<HookCommandRunner> {
  const start = Date.now()
  try {
    execSync(options.command, {
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      timeout: options.timeoutMs,
      stdio: 'ignore',
    })
    return { ok: true, status: 0, signal: null, durationMs: Date.now() - start }
  } catch (err) {
    const { code, status, signal, message } = classifyError(err)
    return {
      ok: false,
      status,
      signal,
      durationMs: Date.now() - start,
      error: redactEnv(message, options.env),
      errorCode: code,
    }
  }
}

/**
 * Minimal surface for surfacing hook failures to the user. Mirrors
 * `Renderer.warn` so the production sink can be wired by binding the
 * renderer. Kept narrow (single method) to avoid coupling this module to
 * the full Renderer interface.
 */
export interface HookFailureSink {
  warn: (message: string) => void
}

export interface HookRunnerOptions {
  /** Override the default `execSync` runner — primarily for tests. */
  runner?: HookCommandRunner
  /** Hard timeout per hook command. Defaults to 10_000 ms. */
  timeoutMs?: number
  /**
   * Sink invoked once per failed hook result. Engine failures never throw.
   * If omitted, hook failures are completely silent — production code MUST
   * wire a sink (typically `renderer.warn`) so misconfigured hooks become
   * visible instead of being silently dropped.
   */
  sink?: HookFailureSink
  /** Backwards-compatible alias for {@link sink}. Prefer `sink` in new code. */
  onFailure?: (result: HookResult) => void
}

function formatFailure(result: HookResult): string {
  const exit = result.status !== null ? `exit ${result.status}` : result.signal ? `signal ${result.signal}` : 'no exit info'
  const code = result.errorCode ? ` [${result.errorCode}]` : ''
  const err = result.error ? `: ${result.error}` : ''
  return `Hook ${result.hook} command '${result.command}' failed${code} (${exit}, ${result.durationMs}ms)${err}`
}

export class HookRunner implements IHookRunner {
  private readonly runner: HookCommandRunner
  private readonly timeoutMs: number
  private readonly sink?: HookFailureSink
  private readonly onFailure?: (result: HookResult) => void

  constructor(private hooks: HooksConfig, options: HookRunnerOptions = {}) {
    this.runner = options.runner ?? defaultRunner
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.sink = options.sink
    this.onFailure = options.onFailure
  }

  private notifyFailure(result: HookResult): void {
    if (this.sink) {
      try {
        this.sink.warn(formatFailure(result))
      } catch {
        // never let the sink break the agent loop
      }
    }
    if (this.onFailure) {
      try {
        this.onFailure(result)
      } catch {
        // never let the sink break the agent loop
      }
    }
  }

  private runEntries(hookName: keyof HooksConfig, toolName: string | undefined, env: Record<string, string>): HookResult[] {
    const entries = this.hooks[hookName] ?? []
    const results: HookResult[] = []
    for (const entry of entries) {
      if (toolName !== undefined && !matchesHook(entry, toolName)) continue
      const exec = this.runner({
        command: entry.command,
        env,
        timeoutMs: this.timeoutMs,
      })
      // Redact sensitive env values from any surfaced error text — applies
      // uniformly whether the runner is the real defaultRunner or an
      // injected fake. We re-redact against the live process.env too so
      // ambient secrets (e.g. ANTHROPIC_API_KEY already in process.env)
      // cannot leak through exec error messages.
      const scrubbedEnv = { ...env, ...pickSensitiveFromProcessEnv() }
      const error = exec.error ? redactEnv(exec.error, scrubbedEnv) : undefined
      const result: HookResult = { hook: hookName, command: entry.command, ...exec, error }
      results.push(result)
      if (!result.ok) this.notifyFailure(result)
    }
    return results
  }

  runPreToolCall(toolName: string, input: Record<string, unknown>): HookResult[] {
    return this.runEntries('PreToolCall', toolName, {
      OVOGO_TOOL_NAME: toolName,
      OVOGO_TOOL_INPUT: JSON.stringify(input).slice(0, MAX_ENV_VALUE_LEN),
    })
  }

  runPostToolCall(toolName: string, result: string, isError: boolean): HookResult[] {
    return this.runEntries('PostToolCall', toolName, {
      OVOGO_TOOL_NAME: toolName,
      OVOGO_TOOL_RESULT: result.slice(0, MAX_ENV_VALUE_LEN),
      OVOGO_TOOL_IS_ERROR: String(isError),
    })
  }

  runUserPromptSubmit(prompt: string): HookResult[] {
    return this.runEntries('UserPromptSubmit', undefined, {
      OVOGO_PROMPT: prompt.slice(0, MAX_ENV_VALUE_LEN),
    })
  }

  runOnError(error: Error, context: { turnNumber: number; lastToolName?: string }): HookResult[] {
    return this.runEntries('OnError', undefined, {
      OVOGO_ERROR_MESSAGE: error.message.slice(0, MAX_ENV_VALUE_LEN),
      OVOGO_TURN_NUMBER: String(context.turnNumber),
      OVOGO_LAST_TOOL: context.lastToolName ?? '',
    })
  }

  runOnComplete(result: TurnResult): HookResult[] {
    return this.runEntries('OnComplete', undefined, {
      OVOGO_RUN_REASON: result.reason,
      OVOGO_RUN_OUTPUT: result.output.slice(0, MAX_ENV_VALUE_LEN),
    })
  }

  runOnContextOverflow(tokensBefore: number, tokensAfter: number): HookResult[] {
    return this.runEntries('OnContextOverflow', undefined, {
      OVOGO_TOKENS_BEFORE: String(tokensBefore),
      OVOGO_TOKENS_AFTER: String(tokensAfter),
    })
  }
}

/** A no-op runner used when no hooks are configured */
export class NoopHookRunner implements IHookRunner {
  runPreToolCall(_toolName: string, _input: Record<string, unknown>): HookResult[] { return [] }
  runPostToolCall(_toolName: string, _result: string, _isError: boolean): HookResult[] { return [] }
  runUserPromptSubmit(_prompt: string): HookResult[] { return [] }
  runOnError(_error: Error, _context: { turnNumber: number; lastToolName?: string }): HookResult[] { return [] }
  runOnComplete(_result: TurnResult): HookResult[] { return [] }
  runOnContextOverflow(_tokensBefore: number, _tokensAfter: number): HookResult[] { return [] }
}