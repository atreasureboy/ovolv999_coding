import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import { SessionNotFoundError, resolveSessionPath } from '../core/sessionManager.js'
export function expandHome(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}
export function normalizeCwd(p: string): string {
  return resolve(expandHome(p))
}
export const DANGEROUS_SESSION_ROOTS: ReadonlySet<string> = new Set([
  '/',
  '/etc',
  '/usr',
  '/var',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/opt',
  '/root',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/run',
  '/srv',
])
export function resolveResumePath(cwd: string, input: string): string {
  assertNonEmptyString(input, 'resume input')
  if (!input.includes('/') && !input.includes('\\')) {
    return resolveSessionPath(cwd, input)
  }
  const abs = resolve(cwd, expandHome(input))
  if (!existsSync(abs)) {
    throw new SessionNotFoundError(`Session path does not exist: ${abs}`)
  }
  const normalized = resolve(abs)
  if (DANGEROUS_SESSION_ROOTS.has(normalized)) {
    throw new SessionNotFoundError(`Refusing to use system directory as a session: ${normalized}`)
  }
  let stat
  try {
    stat = statSync(abs)
  } catch (err) {
    throw new SessionNotFoundError(`Cannot stat session path: ${abs} (${(err as Error).message})`)
  }
  if (stat.isDirectory()) {
    const base = basename(normalized)
    if (!base.startsWith('session_')) {
      throw new SessionNotFoundError(
        `Not a session directory (basename must start with "session_"): ${normalized}`,
      )
    }
    const historyPath = join(normalized, 'history.json')
    if (!existsSync(historyPath)) {
      throw new SessionNotFoundError(`Session directory missing history.json: ${normalized}`)
    }
    try {
      readFileSync(historyPath)
    } catch (err) {
      throw new SessionNotFoundError(
        `Cannot read session history.json: ${historyPath} (${(err as Error).message})`,
      )
    }
    return normalized
  }
  if (stat.isFile()) {
    if (basename(normalized) !== 'history.json') {
      throw new SessionNotFoundError(
        `Not a session history file (must be named "history.json"): ${normalized}`,
      )
    }
    const parentDir = dirname(normalized)
    if (!basename(parentDir).startsWith('session_')) {
      throw new SessionNotFoundError(
        `History file's parent directory must be a session directory (basename must start with "session_"): ${parentDir}`,
      )
    }
    return parentDir
  }
  throw new SessionNotFoundError(`Not a regular file or directory: ${normalized}`)
}
export function assertNonEmptyString(value: string, name: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
}
