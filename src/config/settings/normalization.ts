import type { PermissionMode, PermissionRule } from '../../core/permissionSystem.js'
import type { McpServerConfig } from '../../core/mcpClient.js'
import { ExecutionPolicyError, normalizeExecutionPolicyInput, normalizeExecutionProfile } from '../../core/executionPolicy.js'
import type { HookEntry, HooksConfig, OvogoSettings, TaskContext } from './types.js'

const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'])
const PERMISSION_BEHAVIORS = new Set(['allow', 'deny', 'ask'])
const PERMISSION_SOURCES = new Set(['builtin', 'user', 'project'])

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeHooks(value: unknown): HooksConfig | undefined {
  if (!isObject(value)) return undefined
  const hooks: HooksConfig = {}
  const names = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const
  for (const name of names) {
    const entries = value[name]
    if (!Array.isArray(entries)) continue
    hooks[name] = entries.filter((entry): entry is HookEntry => isObject(entry)
      && ((typeof entry.command === 'string' && Boolean(entry.command.trim()))
        || (Array.isArray(entry.command) && entry.command.length > 0 && entry.command.every(part => typeof part === 'string')))
      && (entry.matcher === undefined || typeof entry.matcher === 'string'))
      .map(entry => ({
        command: typeof entry.command === 'string' ? entry.command : [...entry.command],
        ...(entry.matcher === undefined ? {} : { matcher: entry.matcher }),
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.timeout === undefined ? {} : { timeout: entry.timeout }),
      }))
  }
  return hooks
}

function normalizeTaskContext(value: unknown): TaskContext | undefined {
  if (!isObject(value)) return undefined
  const context: TaskContext = {}
  for (const name of ['name', 'phase', 'notes'] as const) if (typeof value[name] === 'string') context[name] = value[name]
  if (Array.isArray(value.scope)) context.scope = value.scope.filter((item): item is string => typeof item === 'string')
  return context
}

function normalizePermissionRule(value: unknown): PermissionRule | null {
  if (!isObject(value)) return null
  if (typeof value.toolName !== 'string' || !value.toolName.trim()) return null
  if (typeof value.ruleContent !== 'string' || !value.ruleContent.trim()) return null
  if (typeof value.behavior !== 'string' || !PERMISSION_BEHAVIORS.has(value.behavior)) return null
  if (typeof value.source !== 'string' || !PERMISSION_SOURCES.has(value.source)) return null

  return {
    toolName: value.toolName,
    ruleContent: value.ruleContent,
    behavior: value.behavior as PermissionRule['behavior'],
    source: value.source as PermissionRule['source'],
  }
}

function normalizeMcpServer(value: unknown): McpServerConfig | null {
  if (!isObject(value)) return null
  const executionProfile = value.executionProfile === undefined ? undefined : normalizeExecutionProfile(value.executionProfile)
  const executionPolicy = value.executionPolicy === undefined ? undefined : normalizeExecutionPolicyInput(value.executionPolicy)
  let limits: McpServerConfig['limits']
  if (value.limits !== undefined) {
    if (!isObject(value.limits)) throw new ExecutionPolicyError('Invalid MCP limits: expected an object')
    limits = {}
    const keys = ['maxFrameBytes', 'maxRequestBytes', 'maxQueuedBytes', 'maxPending'] as const
    for (const key of Object.keys(value.limits)) {
      if (!keys.includes(key as typeof keys[number])) throw new ExecutionPolicyError(`Invalid MCP limits: unknown field ${key}`)
      const limit = value.limits[key]
      if (!Number.isSafeInteger(limit) || Number(limit) < 1) throw new ExecutionPolicyError(`Invalid MCP limits.${key}: expected a positive safe integer`)
      limits[key as typeof keys[number]] = Number(limit)
    }
  }
  if (typeof value.name !== 'string' || !value.name.trim()) return null
  if (!Array.isArray(value.command) || value.command.length === 0) return null
  if (!value.command.every((c) => typeof c === 'string')) return null
  const env =
    isObject(value.env)
      ? (Object.fromEntries(
          Object.entries(value.env).filter(([, v]) => typeof v === 'string'),
        ) as Record<string, string>)
      : undefined
  const cwd = typeof value.cwd === 'string' ? value.cwd : undefined
  return { name: value.name, type: 'stdio', command: [...value.command], env, cwd,
    ...(executionProfile === undefined ? {} : { executionProfile }),
    ...(executionPolicy === undefined ? {} : { executionPolicy }),
    ...(limits === undefined ? {} : { limits }),
  }
}

function normalizeMcp(value: unknown): { servers: McpServerConfig[] } | undefined {
  if (!isObject(value) || !Array.isArray(value.servers)) return undefined
  const servers = value.servers
    .map(normalizeMcpServer)
    .filter((s): s is McpServerConfig => s !== null)
  return servers.length > 0 ? { servers } : undefined
}

export function normalizeSettings(value: unknown): OvogoSettings {
  if (!isObject(value)) return {}
  const rawPermissions = isObject(value.permissions) ? value.permissions : undefined
  const rawMode = rawPermissions?.mode
  const rawRules = Array.isArray(rawPermissions?.rules) ? rawPermissions.rules : []
  const rules = rawRules
    .map(normalizePermissionRule)
    .filter((rule): rule is PermissionRule => rule !== null)

  return {
    executionPolicy: value.executionPolicy === undefined ? undefined : normalizeExecutionPolicyInput(value.executionPolicy),
    executionProfile: value.executionProfile === undefined ? undefined : normalizeExecutionProfile(value.executionProfile),
    hooks: normalizeHooks(value.hooks),
    taskContext: normalizeTaskContext(value.taskContext),
    poor: isObject(value.poor) && typeof value.poor.enabled === 'boolean'
      ? { enabled: value.poor.enabled }
      : undefined,
    mcp: normalizeMcp(value.mcp),
    permissions: rawPermissions
      ? {
          mode: typeof rawMode === 'string' && PERMISSION_MODES.has(rawMode)
            ? rawMode as PermissionMode
            : undefined,
          rules,
        }
      : undefined,
  }
}
