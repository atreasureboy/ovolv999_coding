import { execManaged, type ExecutionProfile } from './executionBackend.js'
import { loadHooksConfig, matchHook, type HookEvent } from './hooks.js'
import type { HookEntry, HooksConfig } from '../config/settings.js'
import type { HookDecision, HookResult, IHookRunner, TurnResult } from './types.js'

const EVENTS = {
  PreToolCall: 'PreToolUse', PostToolCall: 'PostToolUse', UserPromptSubmit: 'UserPromptSubmit',
  OnError: 'OnError', OnComplete: 'OnComplete', OnContextOverflow: 'OnContextOverflow',
} as const satisfies Record<keyof HooksConfig, HookEvent>

const ENV_KEYS = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL']

export interface HookServiceOptions {
  legacyHooks?: () => Partial<Record<HookEvent, readonly HookEntry[]>>
  sink?: { warn(message: string): void }
  executionProfile?: ExecutionProfile
}

function safeEnvironment(context: Record<string, string>): NodeJS.ProcessEnv {
  const allowed = new Set(ENV_KEYS.map(key => key.toLowerCase()))
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase()))), ...context }
}

function redactSecrets(text: string): string {
  const secrets = Object.entries(process.env).filter(([key, value]) =>
    /(api[_-]?key|token|secret|password|credential|private[_-]?key)/i.test(key) && value && value.length >= 8,
  ).map(([, value]) => value!).sort((left, right) => right.length - left.length)
  for (const secret of secrets) text = text.split(secret).join('[REDACTED]')
  return text
}

function decision(output: string): HookDecision | undefined {
  const text = output.trim()
  if (!text.startsWith('{')) return undefined
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid hook decision')
  const parsed = value as Record<string, unknown>
  if (!['continue', 'deny', 'ask'].includes(String(parsed.action))) throw new Error('Invalid hook decision action')
  if (parsed.reason !== undefined && typeof parsed.reason !== 'string') throw new Error('Invalid hook decision reason')
  if (parsed.updatedInput !== undefined && (!parsed.updatedInput || typeof parsed.updatedInput !== 'object' || Array.isArray(parsed.updatedInput))) throw new Error('Invalid hook updated input')
  return { action: parsed.action as HookDecision['action'],
    ...(parsed.reason === undefined ? {} : { reason: parsed.reason }),
    ...(parsed.updatedInput === undefined ? {} : { updatedInput: parsed.updatedInput as Record<string, unknown> }),
  }
}

export class HookService implements IHookRunner {
  constructor(private readonly hooks: HooksConfig, private readonly cwd: string, private readonly options: HookServiceOptions = {}) {}

  canModifyToolInput(): boolean {
    return (this.hooks.PreToolCall ?? []).some(entry => entry.kind === 'policy') ||
      (((this.options.legacyHooks ?? loadHooksConfig)().PreToolUse?.length ?? 0) > 0)
  }

  private async run(name: keyof HooksConfig, toolName?: string, input?: Record<string, unknown>, extra: Record<string, string> = {}, signal?: AbortSignal): Promise<HookResult[]> {
    const event = EVENTS[name]
    const legacyHooks: Partial<Record<HookEvent, readonly HookEntry[]>> = (this.options.legacyHooks ?? loadHooksConfig)()
    const entries = [
      ...(this.hooks[name] ?? []).map(entry => ({ entry, policy: name === 'PreToolCall' && entry.kind === 'policy' })),
      ...(legacyHooks[event] ?? []).map(entry => ({ entry, policy: name === 'PreToolCall' })),
    ]
    const results: HookResult[] = []
    let effectiveInput = input
    for (const { entry, policy } of entries) {
      signal?.throwIfAborted()
      const matcher = entry.matcher ?? '*'
      if (toolName !== undefined && !matcher.split(',').some(pattern => {
        const trimmed = pattern.trim()
        return matchHook(trimmed, toolName, effectiveInput) || (trimmed.endsWith('*') && toolName.startsWith(trimmed.slice(0, -1)))
      })) continue
      const started = Date.now()
      const command = redactSecrets(typeof entry.command === 'string' ? entry.command : entry.command.join(' '))
      const context = {
        HOOK_EVENT: event, TOOL_NAME: toolName ?? '', HOOK_CWD: this.cwd,
        TOOL_INPUT: effectiveInput ? JSON.stringify(effectiveInput) : '',
        OVOGO_TOOL_NAME: toolName ?? '', OVOGO_TOOL_INPUT: effectiveInput ? JSON.stringify(effectiveInput) : '',
        ...extra,
      }
      const env = safeEnvironment(context)
      const configured = this.options.executionProfile
      const profile = configured?.envAllowlist ? { ...configured, envAllowlist: [...configured.envAllowlist, ...Object.keys(context)] } : configured
      let result: HookResult
      try {
        const argv = typeof entry.command === 'string'
          ? process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', '/d', '/s', '/c', '"' + entry.command + '"'] : ['/bin/sh', '-c', entry.command]
          : [...entry.command]
        if (!argv[0] || (entry.kind !== undefined && !['policy', 'notification'].includes(entry.kind))) throw new Error('Invalid hook configuration')
        const output = await execManaged(argv[0], argv.slice(1), { cwd: this.cwd, env, profile, signal, windowsHide: true,
          windowsVerbatimArguments: process.platform === 'win32' && typeof entry.command === 'string',
          maxBuffer: 65536, timeoutMs: entry.timeout ?? 10000 })
        const parsed = policy ? decision(output.stdout) : undefined
        if (parsed?.reason) parsed.reason = redactSecrets(parsed.reason)
        result = { hook: event, command, ok: true, status: 0, signal: null, durationMs: Date.now() - started,
          ...(parsed ? { decision: parsed } : {}),
        }
      } catch (error) {
        const failure = error as { status?: number | null; stderr?: string; stdout?: string; message?: string }
        const reason = redactSecrets(failure.stderr?.trim() || failure.message || String(error)).slice(0, 4096)
        result = { hook: event, command, ok: false, status: failure.status ?? null, signal: null,
          durationMs: Date.now() - started, error: reason, errorCode: 'non_zero',
          ...(policy ? { decision: { action: 'deny', reason } } : {}),
        }
        try { this.options.sink?.warn(`Hook ${event} failed: ${reason}`) } catch (error) { void error }
      }
      results.push(result)
      if (result.decision?.updatedInput) effectiveInput = result.decision.updatedInput
      if (result.decision?.action === 'deny') break
    }
    return results
  }

  runPreToolCall(toolName: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('PreToolCall', toolName, input, {}, signal)
  }

  runPostToolCall(toolName: string, result: string, isError: boolean, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('PostToolCall', toolName, undefined, { TOOL_OUTPUT: result.slice(0, 4096), OVOGO_TOOL_RESULT: result.slice(0, 4096), OVOGO_TOOL_IS_ERROR: String(isError) }, signal)
  }

  runUserPromptSubmit(prompt: string, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('UserPromptSubmit', undefined, undefined, { PROMPT: prompt.slice(0, 4096), OVOGO_PROMPT: prompt.slice(0, 4096) }, signal)
  }

  runOnError(error: Error, context: { turnNumber: number; lastToolName?: string }, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('OnError', undefined, undefined, { OVOGO_ERROR_MESSAGE: error.message.slice(0, 4096), OVOGO_TURN_NUMBER: String(context.turnNumber), OVOGO_LAST_TOOL: context.lastToolName ?? '' }, signal)
  }

  runOnComplete(result: TurnResult, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('OnComplete', undefined, undefined, { OVOGO_RUN_REASON: result.reason, OVOGO_RUN_OUTPUT: result.output.slice(0, 4096) }, signal)
  }

  runOnContextOverflow(tokensBefore: number, tokensAfter: number, signal?: AbortSignal): Promise<HookResult[]> {
    return this.run('OnContextOverflow', undefined, undefined, { OVOGO_TOKENS_BEFORE: String(tokensBefore), OVOGO_TOKENS_AFTER: String(tokensAfter) }, signal)
  }
}
