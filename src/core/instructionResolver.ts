import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import type { Stats } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

export interface ResolvedInstruction {
  readonly path: string
  readonly scope: string
  readonly content: string
  readonly digest: string
  readonly boundary?: string
}

export interface InstructionTargetSnapshot {
  readonly instructions: readonly ResolvedInstruction[]
  readonly targetBoundaries: readonly { readonly path: string; readonly boundary: string }[]
  readonly startupBoundary: string
}

export interface InstructionDiagnostic {
  readonly code: 'incomparable-scopes'
  readonly scopes: readonly string[]
  readonly message: string
}

export const INSTRUCTION_LIMITS = Object.freeze({
  fileBytes: 25_000,
  fileLines: 200,
  totalBytes: 250_000,
  files: 128,
  targetPaths: 64,
  directories: 256,
  pathCharacters: 32_768,
})

export const INSTRUCTION_COMPATIBILITY_ORDER = Object.freeze([
  'CLAUDE.md',
  '.claude/CLAUDE.md',
  '.ovolv999/CLAUDE.md',
  '.ovolv999/instructions.md',
  'OVOGO.md',
  'AGENTS.md',
  '.ovogo/OVOGO.md',
])

export class InstructionResolutionError extends Error {
  constructor(
    readonly code: 'unreadable' | 'malformed' | 'capacity' | 'outside-root' | 'symlink-escape',
    readonly path: string,
    detail: string,
  ) {
    super(`Instruction resolution failed at ${path}: ${detail}`)
    this.name = 'InstructionResolutionError'
  }
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function isWithin(root: string, path: string): boolean {
  const suffix = relative(root, path)
  return suffix === '' || (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`))
}

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function failure(path: string, error: unknown): InstructionResolutionError {
  return error instanceof InstructionResolutionError
    ? error
    : new InstructionResolutionError('unreadable', path, error instanceof Error ? error.message : String(error))
}

function sameFileSnapshot(left: Stats, right: Stats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

function checkPath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0')) {
    throw new InstructionResolutionError('malformed', String(path), 'expected a nonempty path without NUL characters')
  }
  if (path.length > INSTRUCTION_LIMITS.pathCharacters) {
    throw new InstructionResolutionError('capacity', path.slice(0, 200), 'path length exceeds the instruction lookup limit')
  }
}

function canonicalExisting(path: string): string {
  try {
    return realpathSync(path)
  } catch (error) {
    throw failure(path, error)
  }
}

function workspaceRoot(cwd: string, fallback = cwd): string {
  try {
    const root = realpathSync(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, maxBuffer: 65_536,
    }).trim())
    if (isWithin(root, cwd)) return root
  } catch (error) {
    void error
  }
  let current = cwd
  for (let count = 0; count < INSTRUCTION_LIMITS.directories; count++) {
    try {
      lstatSync(join(current, '.git'))
      return current
    } catch (error) {
      if (!missing(error)) throw failure(join(current, '.git'), error)
    }
    const parent = dirname(current)
    if (parent === current) return fallback
    current = parent
  }
  throw new InstructionResolutionError('capacity', cwd, 'repository discovery exceeds the directory limit')
}

function ancestry(root: string, directory: string): string[] {
  const chain: string[] = []
  let current = directory
  while (true) {
    if (chain.length >= INSTRUCTION_LIMITS.directories) {
      throw new InstructionResolutionError('capacity', directory, 'instruction ancestry exceeds the directory limit')
    }
    chain.push(current)
    if (pathKey(current) === pathKey(root)) return chain.reverse()
    const parent = dirname(current)
    if (parent === current || !isWithin(root, parent)) {
      throw new InstructionResolutionError('outside-root', directory, `target is outside repository boundary ${root}`)
    }
    current = parent
  }
}

function locateTarget(cwd: string, input: string): { target: string; physical: string; directory: string; existingDirectory: string } {
  checkPath(input)
  const target = resolve(cwd, input)
  let existing = target
  const remainder: string[] = []
  while (true) {
    try {
      lstatSync(existing)
      break
    } catch (error) {
      if (!missing(error)) throw failure(existing, error)
      if (remainder.length >= INSTRUCTION_LIMITS.directories) {
        throw new InstructionResolutionError('capacity', target, 'target ancestry exceeds the directory limit')
      }
      const parent = dirname(existing)
      if (parent === existing) throw failure(existing, error)
      remainder.unshift(relative(parent, existing))
      existing = parent
    }
  }
  const physical = canonicalExisting(existing)
  try {
    const info = statSync(physical)
    if (remainder.length && !info.isDirectory()) {
      throw new InstructionResolutionError('unreadable', target, 'target ancestor is not a directory')
    }
    const resolvedTarget = resolve(physical, ...remainder)
    return {
      target,
      physical: resolvedTarget,
      directory: remainder.length || !info.isDirectory() ? dirname(resolvedTarget) : resolvedTarget,
      existingDirectory: info.isDirectory() ? physical : dirname(physical),
    }
  } catch (error) {
    throw failure(target, error)
  }
}

function readInstruction(path: string, scope: string, boundary: string): ResolvedInstruction | undefined {
  try {
    lstatSync(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw failure(path, error)
  }
  const physical = canonicalExisting(path)
  if (!isWithin(boundary, physical)) {
    throw new InstructionResolutionError('symlink-escape', path, `instruction source escapes boundary ${boundary}`)
  }
  let descriptor: number | undefined
  try {
    const expected = statSync(physical)
    if (!expected.isFile()) throw new InstructionResolutionError('unreadable', path, 'instruction source must be a regular file')
    if (expected.size > INSTRUCTION_LIMITS.fileBytes) {
      throw new InstructionResolutionError('capacity', path, `instruction exceeds ${INSTRUCTION_LIMITS.fileBytes} bytes`)
    }
    descriptor = openSync(physical, 'r')
    const opened = fstatSync(descriptor)
    if (!sameFileSnapshot(expected, opened) || realpathSync(path) !== physical) {
      throw new InstructionResolutionError('unreadable', path, 'instruction source changed during lookup; retry resolution')
    }
    const buffer = Buffer.alloc(INSTRUCTION_LIMITS.fileBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, length)
      if (!count) break
      length += count
    }
    if (length > INSTRUCTION_LIMITS.fileBytes) {
      throw new InstructionResolutionError('capacity', path, `instruction exceeds ${INSTRUCTION_LIMITS.fileBytes} bytes`)
    }
    const after = fstatSync(descriptor)
    const current = statSync(path)
    if (length !== opened.size || !sameFileSnapshot(opened, after) || !sameFileSnapshot(after, current) || realpathSync(path) !== physical) {
      throw new InstructionResolutionError('unreadable', path, 'instruction source changed during reading; retry resolution')
    }
    let content: string
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      throw new InstructionResolutionError('malformed', path, 'instruction must contain valid UTF-8 text')
    }
    if (content.includes('\0')) throw new InstructionResolutionError('malformed', path, 'instruction contains NUL characters')
    if (content.split('\n').length > INSTRUCTION_LIMITS.fileLines) {
      throw new InstructionResolutionError('capacity', path, `instruction exceeds ${INSTRUCTION_LIMITS.fileLines} lines`)
    }
    if (!content.trim()) return undefined
    return Object.freeze({ path, scope, content: content.trim(), digest: createHash('sha256').update(buffer.subarray(0, length)).digest('hex'), ...(scope === '*' ? {} : { boundary }) })
  } catch (error) {
    throw failure(path, error)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

function resolveInstructionSetSync(cwd: string, targetPaths: readonly string[], allowExternalTargets: boolean): InstructionTargetSnapshot {
  checkPath(cwd)
  if (!Array.isArray(targetPaths)) throw new InstructionResolutionError('malformed', cwd, 'target paths must be an array')
  if (targetPaths.length > INSTRUCTION_LIMITS.targetPaths) {
    throw new InstructionResolutionError('capacity', cwd, `instruction lookup exceeds ${INSTRUCTION_LIMITS.targetPaths} targets`)
  }
  const canonicalCwd = canonicalExisting(resolve(cwd))
  if (!statSync(canonicalCwd).isDirectory()) throw new InstructionResolutionError('unreadable', cwd, 'working directory must be a directory')
  const root = workspaceRoot(canonicalCwd)
  const boundaries = new Map([[pathKey(canonicalCwd), root], [pathKey(root), root]])
  const startup = ancestry(root, canonicalCwd)
  const directories = new Map(startup.map(directory => [pathKey(directory), { directory, boundary: root }]))
  const additional = new Map<string, { directory: string; boundary: string }>()
  const targets = new Map<string, { readonly path: string; readonly boundary: string }>()
  for (const input of targetPaths) {
    checkPath(input)
    const target = resolve(canonicalCwd, input)
    if (!allowExternalTargets && !isWithin(root, target)) {
      throw new InstructionResolutionError('outside-root', target, `target is outside repository boundary ${root}`)
    }
    const located = locateTarget(canonicalCwd, input)
    if (!allowExternalTargets && !isWithin(root, located.physical)) {
      throw new InstructionResolutionError('symlink-escape', target, `resolved target escapes repository boundary ${root}`)
    }
    const directoryKey = pathKey(located.existingDirectory)
    let boundary = boundaries.get(directoryKey)
    if (!boundary) {
      boundary = workspaceRoot(located.existingDirectory, isWithin(root, located.physical) ? root : located.existingDirectory)
      boundaries.set(directoryKey, boundary)
    }
    targets.set(pathKey(located.physical), Object.freeze({ path: located.physical, boundary }))
    for (const directory of ancestry(boundary, located.directory)) {
      if (!directories.has(pathKey(directory))) additional.set(pathKey(directory), { directory, boundary })
      if (directories.size + additional.size > INSTRUCTION_LIMITS.directories) {
        throw new InstructionResolutionError('capacity', directory, 'instruction lookup exceeds the directory limit')
      }
    }
  }
  for (const item of [...additional.values()].sort((left, right) => {
    const depthDifference = left.directory.split(sep).length - right.directory.split(sep).length
    return depthDifference || pathKey(left.directory).localeCompare(pathKey(right.directory), 'en')
  })) directories.set(pathKey(item.directory), item)
  const entries: ResolvedInstruction[] = []
  const sources = new Set<string>()
  let bytes = 0
  const append = (path: string, scope: string, boundary: string): void => {
    if (sources.has(pathKey(path))) return
    const entry = readInstruction(path, scope, boundary)
    if (!entry) return
    if (entries.length >= INSTRUCTION_LIMITS.files || bytes + Buffer.byteLength(entry.content, 'utf8') > INSTRUCTION_LIMITS.totalBytes) {
      throw new InstructionResolutionError('capacity', path, 'combined instructions exceed the file or byte limit')
    }
    entries.push(entry)
    sources.add(pathKey(path))
    bytes += Buffer.byteLength(entry.content, 'utf8')
  }
  const home = resolve(homedir())
  let canonicalHome = home
  try { canonicalHome = realpathSync(home) } catch (error) { if (!missing(error)) throw failure(home, error) }
  append(join(home, '.ovogo', 'OVOGO.md'), '*', canonicalHome)
  for (const { directory, boundary } of directories.values()) {
    for (const name of INSTRUCTION_COMPATIBILITY_ORDER) append(join(directory, name), directory, boundary)
  }
  return Object.freeze({ instructions: Object.freeze(entries), targetBoundaries: Object.freeze([...targets.values()]), startupBoundary: root })
}

export function resolveInstructionsSync(cwd: string, targetPaths: readonly string[]): readonly ResolvedInstruction[] {
  return resolveInstructionSetSync(cwd, targetPaths, false).instructions
}

export function resolveInstructions(cwd: string, targetPaths: readonly string[]): Promise<readonly ResolvedInstruction[]> {
  return Promise.resolve().then(() => resolveInstructionsSync(cwd, targetPaths))
}

export function resolveTargetInstructions(cwd: string, targetPaths: readonly string[], options: { allowExternalTargets?: boolean } = {}): Promise<InstructionTargetSnapshot> {
  return Promise.resolve().then(() => resolveInstructionSetSync(cwd, targetPaths, options.allowExternalTargets === true))
}

export function getInstructionDiagnostics(entries: readonly ResolvedInstruction[]): readonly InstructionDiagnostic[] {
  const scopes = [...new Set(entries.map(entry => entry.scope).filter(scope => scope !== '*'))].sort((left, right) => pathKey(left).localeCompare(pathKey(right), 'en'))
  const incomparable = scopes.filter(scope => scopes.some(other => !isWithin(scope, other) && !isWithin(other, scope)))
  if (incomparable.length < 2) return Object.freeze([])
  return Object.freeze([Object.freeze({
    code: 'incomparable-scopes' as const,
    scopes: Object.freeze(incomparable),
    message: 'Multiple incomparable directory scopes are present. Their rules may conflict; keep each rule within its scope and request clarification if an operation cannot satisfy all applicable rules.',
  })])
}

export function formatInstructionsForPrompt(entries: readonly ResolvedInstruction[]): string {
  if (!entries.length) return ''
  const diagnostics = getInstructionDiagnostics(entries).map(diagnostic => `${diagnostic.code}: ${diagnostic.message}\nScopes: ${diagnostic.scopes.map(scope => JSON.stringify(scope)).join(', ')}`)
  const sections = entries.map(entry => [
    `Source: ${JSON.stringify(entry.path)}`,
    `Scope: ${entry.scope === '*' ? '* (personal global instructions)' : `${JSON.stringify(entry.scope)} (this directory and descendants only)`}`,
    ...(entry.boundary ? [`Lookup boundary: ${JSON.stringify(entry.boundary)} (applies only to targets resolved in this boundary; independent nested repositories use their own boundary)`] : []),
    `Digest: ${entry.digest}`,
    '',
    entry.content,
  ].join('\n'))
  return [
    '## Applicable Path Instructions',
    'Apply each source only to its stated scope. Sources are ordered from outer to inner directories; later sources in the same applicable chain take precedence. Sibling scopes never override one another.',
    `Compatibility order within each directory: ${INSTRUCTION_COMPATIBILITY_ORDER.join(', ')}.`,
    ...diagnostics,
    ...sections,
  ].join('\n\n')
}
