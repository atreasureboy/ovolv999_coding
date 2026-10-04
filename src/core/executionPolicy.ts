import { posix, win32 } from 'node:path'
import type { ExecutionProfile } from './executionBackend.js'

export interface ExecutionPolicy {
  mode: 'trusted-local' | 'isolated-worker'
  readableRoots: readonly string[]
  writableRoots: readonly string[]
  deniedPaths: readonly string[]
  network: 'deny' | 'allowlist' | 'unrestricted'
  allowedHosts: readonly string[]
  envAllowlist: readonly string[]
  limits: { processes: number; memoryBytes?: number; cpuMs?: number }
}

export interface ExecutionPolicyInput extends Partial<Omit<ExecutionPolicy, 'limits'>> {
  limits?: Partial<ExecutionPolicy['limits']>
}

export class ExecutionPolicyError extends Error {
  constructor(message: string, readonly code: 'invalid_policy' | 'unsupported_policy' = 'invalid_policy') {
    super(message)
    this.name = 'ExecutionPolicyError'
  }
}

const COMMON_ENV = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ']
const WINDOWS_ENV = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA']

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutionPolicyError(`Invalid ${field}: expected an object`)
  return value as Record<string, unknown>
}

function knownKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new ExecutionPolicyError(`Invalid ${field}: unknown field ${key}`)
}

function stringList(value: unknown, field: string, normalize: (value: string) => string): string[] {
  if (!Array.isArray(value)) throw new ExecutionPolicyError(`Invalid ${field}: expected a string array`)
  return [...new Set(value.map(item => {
    if (typeof item !== 'string' || !item || item !== item.trim() || item.includes('\0')) throw new ExecutionPolicyError(`Invalid ${field}: expected nonempty strings without surrounding whitespace or NUL`)
    return normalize(item)
  }))]
}

function absolutePath(value: string, field: string): string {
  const paths = process.platform === 'win32' ? win32 : posix
  if (!paths.isAbsolute(value) || (process.platform === 'win32' && !/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(value))) throw new ExecutionPolicyError(`Invalid ${field}: path must be fully absolute`)
  if (/^\\\\[?.]\\/.test(value) || value.split(/[\\/]/).includes('..')) throw new ExecutionPolicyError(`Invalid ${field}: path traversal and device roots are not allowed`)
  return paths.normalize(value)
}

function environmentName(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new ExecutionPolicyError(`Invalid envAllowlist variable name: ${value}`)
  return process.platform === 'win32' ? value.toUpperCase() : value
}

function host(value: string): string {
  if (/[\\/@?#\s]/.test(value)) throw new ExecutionPolicyError(`Invalid allowedHosts entry: expected a host without URL, credentials, or path`)
  try {
    const url = new URL('http://' + value)
    if (!url.hostname || url.pathname !== '/' || (url.port && (Number(url.port) < 1 || Number(url.port) > 65535))) throw new Error('invalid host')
    return url.host.toLowerCase()
  } catch {
    throw new ExecutionPolicyError(`Invalid allowedHosts entry: ${value}`)
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ExecutionPolicyError(`Invalid ${field}: expected a positive safe integer`)
  return Number(value)
}

export function normalizeExecutionPolicyInput(input: unknown): ExecutionPolicyInput {
  const raw = object(input, 'executionPolicy')
  knownKeys(raw, ['mode', 'readableRoots', 'writableRoots', 'deniedPaths', 'network', 'allowedHosts', 'envAllowlist', 'limits'], 'executionPolicy')
  const normalized: ExecutionPolicyInput = {}
  if (raw.mode !== undefined) {
    if (raw.mode !== 'trusted-local' && raw.mode !== 'isolated-worker') throw new ExecutionPolicyError('Invalid executionPolicy mode')
    normalized.mode = raw.mode
  }
  for (const key of ['readableRoots', 'writableRoots', 'deniedPaths'] as const) {
    if (raw[key] !== undefined) normalized[key] = stringList(raw[key], key, value => absolutePath(value, key))
  }
  if (raw.network !== undefined) {
    if (raw.network !== 'deny' && raw.network !== 'allowlist' && raw.network !== 'unrestricted') throw new ExecutionPolicyError('Invalid executionPolicy network mode')
    normalized.network = raw.network
  }
  if (raw.allowedHosts !== undefined) normalized.allowedHosts = stringList(raw.allowedHosts, 'allowedHosts', host)
  if (raw.envAllowlist !== undefined) normalized.envAllowlist = stringList(raw.envAllowlist, 'envAllowlist', environmentName)
  if (raw.limits !== undefined) {
    const limits = object(raw.limits, 'executionPolicy limits')
    knownKeys(limits, ['processes', 'memoryBytes', 'cpuMs'], 'executionPolicy limits')
    normalized.limits = {}
    for (const key of ['processes', 'memoryBytes', 'cpuMs'] as const) if (limits[key] !== undefined) normalized.limits[key] = positiveInteger(limits[key], `executionPolicy limits.${key}`)
  }
  return normalized
}

export function normalizeExecutionProfile(input: unknown): ExecutionProfile {
  const raw = object(input, 'executionProfile')
  knownKeys(raw, ['mode', 'envAllowlist', 'maxProcesses'], 'executionProfile')
  if (raw.mode !== 'trusted-local' && raw.mode !== 'isolated-worker') throw new ExecutionPolicyError('Invalid executionProfile mode')
  return {
    mode: raw.mode,
    ...(raw.envAllowlist === undefined ? {} : { envAllowlist: stringList(raw.envAllowlist, 'executionProfile envAllowlist', environmentName) }),
    ...(raw.maxProcesses === undefined ? {} : { maxProcesses: positiveInteger(raw.maxProcesses, 'executionProfile maxProcesses') }),
  }
}

export function resolveExecutionPolicy(input: unknown, cwd: string): ExecutionPolicy {
  absolutePath(cwd, 'executionPolicy cwd')
  const normalized = input === undefined ? {} : normalizeExecutionPolicyInput(input)
  const essential = process.platform === 'win32' ? WINDOWS_ENV : COMMON_ENV
  const policy: ExecutionPolicy = {
    mode: normalized.mode ?? 'trusted-local',
    readableRoots: normalized.readableRoots ?? [], writableRoots: normalized.writableRoots ?? [], deniedPaths: normalized.deniedPaths ?? [],
    network: normalized.network ?? 'unrestricted', allowedHosts: normalized.allowedHosts ?? [],
    envAllowlist: [...new Set([...essential, ...(normalized.envAllowlist ?? [])])],
    limits: { processes: normalized.limits?.processes ?? 64, ...normalized.limits },
  }
  const paths = process.platform === 'win32' ? win32 : posix
  if (policy.readableRoots.length && policy.writableRoots.some(writable => !policy.readableRoots.some(readable => {
    const relative = paths.relative(readable, writable)
    return !paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + paths.sep)
  }))) throw new ExecutionPolicyError('Invalid writableRoots scope: every writable root must be within a readable root')
  if (policy.network === 'allowlist' && !policy.allowedHosts.length) throw new ExecutionPolicyError('Invalid network allowlist: allowedHosts must not be empty')
  if (policy.network !== 'allowlist' && policy.allowedHosts.length) throw new ExecutionPolicyError('Invalid allowedHosts: a host list requires network allowlist mode')
  return policy
}

export function executionPolicyFromProfile(profile: ExecutionProfile, cwd: string): ExecutionPolicy {
  const normalized = normalizeExecutionProfile(profile)
  return resolveExecutionPolicy({ mode: normalized.mode, envAllowlist: normalized.envAllowlist, limits: normalized.maxProcesses === undefined ? undefined : { processes: normalized.maxProcesses } }, cwd)
}

export function resolveManagedExecutionPolicy(profile: ExecutionProfile | undefined, policy: unknown, cwd: string): ExecutionPolicy {
  if (policy === undefined && profile !== undefined) return executionPolicyFromProfile(profile, cwd)
  const resolved = resolveExecutionPolicy(policy, cwd)
  if (profile === undefined) return resolved
  const legacy = normalizeExecutionProfile(profile)
  const allowed = legacy.envAllowlist === undefined ? undefined : new Set(executionPolicyFromProfile(legacy, cwd).envAllowlist)
  return {
    ...resolved,
    mode: legacy.mode === 'isolated-worker' ? 'isolated-worker' : resolved.mode,
    envAllowlist: allowed ? resolved.envAllowlist.filter(key => allowed.has(key)) : resolved.envAllowlist,
    limits: { ...resolved.limits, processes: Math.min(resolved.limits.processes, legacy.maxProcesses ?? resolved.limits.processes) },
  }
}

export function buildChildEnvironment(policy: ExecutionPolicy, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set(policy.envAllowlist.map(environmentName))
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(source).sort()) {
    const normalized = process.platform === 'win32' ? key.toUpperCase() : key
    const value = source[key]
    if (allowed.has(normalized) && value !== undefined && env[normalized] === undefined) env[normalized] = value
  }
  return env
}

export function mergeChildEnvironment(source: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return { ...source, ...overrides }
  const env: NodeJS.ProcessEnv = {}
  for (const key of Object.keys(source).sort()) {
    const normalized = key.toUpperCase()
    if (env[normalized] === undefined) env[normalized] = source[key]
  }
  for (const [key, value] of Object.entries(overrides)) env[key.toUpperCase()] = value
  return env
}

export function assertSupportedExecutionPolicy(policy: ExecutionPolicy): void {
  if (policy.mode === 'isolated-worker') throw new ExecutionPolicyError(`Process isolation is unavailable on ${process.platform}; isolated-worker execution refused`, 'unsupported_policy')
  if (policy.readableRoots.length || policy.writableRoots.length || policy.deniedPaths.length) throw new ExecutionPolicyError('Native filesystem restrictions are unavailable in trusted-local mode; configured path boundaries refused. Empty roots mean no native path boundary requested.', 'unsupported_policy')
  if (policy.network !== 'unrestricted') throw new ExecutionPolicyError('Native network restrictions are unavailable in trusted-local mode; configured network restriction refused', 'unsupported_policy')
  if (policy.limits.memoryBytes !== undefined || policy.limits.cpuMs !== undefined) throw new ExecutionPolicyError('Native memory/CPU quotas are unavailable in trusted-local mode; configured resource quota refused', 'unsupported_policy')
}
