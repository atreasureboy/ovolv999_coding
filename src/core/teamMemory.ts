/**
 * Team Memory Sync
 *
 * Shares CLAUDE.md/AGENTS.md-style memory files across a team.
 * Strips secrets before syncing. Git-backed for history.
 *
 * Workflow:
 *   1. Team configures a shared git repo as memory store
 *   2. Local memory files are scanned for secrets
 *   3. Clean versions are pushed to the shared repo
 *   4. Other team members pull to get updates
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, lstatSync } from 'fs'
import { join, basename, relative, isAbsolute } from 'path'
import { homedir } from 'os'
import { execFileSync } from 'child_process'
import { scanText, formatScanResult } from '../utils/secretScanner.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface TeamMemoryConfig {
  /** Git remote URL for shared memory store */
  remoteUrl: string
  /** Branch to sync (default: main) */
  branch?: string
  /** Local memory files to sync */
  files: string[]
  /** Whether to auto-sync on changes */
  autoSync?: boolean
  /** Sync interval in ms (default: 5 min) */
  syncInterval?: number
}

export interface SyncResult {
  success: boolean
  pushed: string[]
  pulled: string[]
  errors: string[]
  secretsDetected: number
  warnings: string[]
}

export interface MemoryFile {
  path: string
  content: string
  hash: string
}

// ── Paths ───────────────────────────────────────────────────────────────────

export function getTeamMemoryDir(): string {
  return join(homedir(), '.ovolv999', 'team-memory')
}

export function getTeamMemoryConfigPath(): string {
  return join(homedir(), '.ovolv999', 'team-memory.json')
}

// ── Config ──────────────────────────────────────────────────────────────────

export function loadTeamConfig(): TeamMemoryConfig | null {
  const path = getTeamMemoryConfigPath()
  if (!existsSync(path)) return null
  try {
    const config: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isTeamConfig(config) ? config : null
  } catch {
    return null
  }
}

export function saveTeamConfig(config: TeamMemoryConfig): void {
  const path = getTeamMemoryConfigPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(config, null, 2))
}

// ── Memory File Discovery ───────────────────────────────────────────────────

const DEFAULT_MEMORY_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.cursorrules',
  '.windsurfrules',
  '.ovolv999/memory.md',
]

export function findMemoryFiles(cwd: string): string[] {
  const found: string[] = []
  for (const name of DEFAULT_MEMORY_FILES) {
    const path = join(cwd, name)
    if (existsSync(path) && statSync(path).isFile()) found.push(path)
  }
  return found
}

export function loadMemoryFiles(files: string[]): MemoryFile[] {
  return files
    .filter(f => existsSync(f) && statSync(f).isFile())
    .map(f => {
      const content = readFileSync(f, 'utf8')
      return { path: f, content, hash: simpleHash(content) }
    })
}

function simpleHash(s: string): string {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0
  }
  return h.toString(16)
}

// ── Git Operations ──────────────────────────────────────────────────────────

function runGit(args: string[], cwd?: string): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('git', args, {
      cwd: cwd ?? getTeamMemoryDir(),
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, stdout, stderr: '' }
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      ok: false,
      stdout: (e.stdout ?? '').toString(),
      stderr: (e.stderr ?? e.message ?? String(err)).toString(),
    }
  }
}

export function isTeamMemoryInitialized(): boolean {
  return existsSync(join(getTeamMemoryDir(), '.git'))
}

export function initTeamMemory(remoteUrl: string, branch = 'main'): SyncResult {
  const dir = getTeamMemoryDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const errors: string[] = []
  const warnings: string[] = []
  const result = (): SyncResult => ({ success: errors.length === 0, pushed: [], pulled: [], errors, secretsDetected: 0, warnings })

  const validBranch = runGit(['check-ref-format', '--branch', branch], dir)
  if (!validBranch.ok) {
    errors.push(`Invalid branch: ${validBranch.stderr}`)
    return result()
  }

  // Init local repo
  let res = runGit(['init'], dir)
  if (!res.ok) {
    errors.push(`git init failed: ${res.stderr}`)
    return result()
  }

  // Set default branch
  res = runGit(['checkout', '-b', branch], dir)
  if (!res.ok) res = runGit(['checkout', branch], dir)
  if (!res.ok) {
    errors.push(`Branch checkout failed: ${res.stderr}`)
    return result()
  }

  // Add remote
  res = runGit(['remote', 'add', 'origin', remoteUrl], dir)
  if (!res.ok) {
    // Remote might already exist
    res = runGit(['remote', 'set-url', 'origin', remoteUrl], dir)
    if (!res.ok) {
      errors.push(`Remote configuration failed: ${res.stderr}`)
      return result()
    }
  }

  // Pull
  res = runGit(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], dir)
  if (!res.ok) errors.push(`Remote lookup failed: ${res.stderr}`)
  else if (res.stdout.trim()) {
    res = runGit(['pull', '--rebase', 'origin', branch], dir)
    if (!res.ok) errors.push(`Initial pull failed: ${res.stderr}`)
  }
  return result()
}

// ── Sync ────────────────────────────────────────────────────────────────────

export function syncTeamMemory(config?: TeamMemoryConfig): SyncResult {
  const cfg = config ?? loadTeamConfig()
  if (!isTeamConfig(cfg)) {
    return {
      success: false,
      pushed: [],
      pulled: [],
      errors: ['No team memory config found. Use /team-memory init <remote-url>'],
      secretsDetected: 0,
      warnings: [],
    }
  }

  const errors: string[] = []
  const warnings: string[] = []
  const pushed: string[] = []
  const pulled: string[] = []
  let secretsDetected = 0
  const copied: string[] = []
  const result = (): SyncResult => ({ success: errors.length === 0, pushed, pulled, errors, secretsDetected, warnings })

  // Ensure initialized
  if (!isTeamMemoryInitialized()) {
    const initResult = initTeamMemory(cfg.remoteUrl, cfg.branch ?? 'main')
    if (!initResult.success) {
      return {
        success: false,
        pushed,
        pulled,
        errors: initResult.errors,
        secretsDetected: 0,
        warnings: initResult.warnings,
      }
    }
  }

  // Scan and copy local files to team memory dir
  const memoryDir = getTeamMemoryDir()
  for (const file of cfg.files) {
    if (!existsSync(file)) {
      warnings.push(`File not found: ${file}`)
      continue
    }

    const filename = basename(file)
    const destPath = join(memoryDir, filename)
    if (filename.toLowerCase() === '.git' || copied.includes(filename)) {
      errors.push(`Unsafe or duplicate memory filename: ${filename}`)
      return result()
    }
    try {
      if (existsSync(destPath) && lstatSync(destPath).isSymbolicLink()) throw new Error('Destination is a symbolic link')
      const content = readFileSync(file, 'utf8')
      const scan = scanText(content)
      secretsDetected += scan.matches.length
      if (scan.hasSecrets) warnings.push(`Secrets in ${file}: ${formatScanResult(scan)}`)
      writeFileSync(destPath, scan.cleanedContent)
      copied.push(filename)
    } catch (err) {
      errors.push(`Memory file failed: ${file}: ${(err as Error).message}`)
      return result()
    }
  }

  // Git add
  if (copied.length > 0) {
    const addRes = runGit(['add', '--', ...copied])
    if (!addRes.ok) {
      errors.push(`Add failed: ${addRes.stderr}`)
      return result()
    }
  }

  // Commit
  const staged = runGit(['diff', '--cached', '--name-only'])
  if (!staged.ok) {
    errors.push(`Staged changes check failed: ${staged.stderr}`)
    return result()
  }
  if (staged.stdout.trim()) {
    const commitRes = runGit(['commit', '-m', `sync memory files (${new Date().toISOString()})`])
    if (!commitRes.ok) {
      errors.push(`Commit failed: ${commitRes.stderr}`)
      return result()
    }
  }

  // Pull first (to avoid conflicts)
  const branch = cfg.branch ?? 'main'
  const remoteRes = runGit(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])
  if (!remoteRes.ok) {
    errors.push(`Remote lookup failed: ${remoteRes.stderr}`)
    return result()
  }
  if (remoteRes.stdout.trim()) {
    const pullRes = runGit(['pull', '--rebase', 'origin', branch])
    if (!pullRes.ok) {
      errors.push(`Pull failed: ${pullRes.stderr}`)
      return result()
    }
    // Check what was pulled
    const files = listTeamMemoryFiles()
    pulled.push(...files.map(f => basename(f)))
  }

  // Push
  const pushRes = runGit(['push', 'origin', `HEAD:refs/heads/${branch}`])
  if (!pushRes.ok) {
    errors.push(`Push failed: ${pushRes.stderr.slice(0, 200)}`)
  } else pushed.push(...copied)

  return result()
}

// ── File Operations ─────────────────────────────────────────────────────────

export function listTeamMemoryFiles(): string[] {
  const dir = getTeamMemoryDir()
  if (!existsSync(dir)) return []

  try {
    return readdirSync(dir)
      .filter(f => !f.startsWith('.') && f !== 'node_modules')
      .filter(f => {
        try {
          return statSync(join(dir, f)).isFile()
        } catch {
          return false
        }
      })
      .map(f => join(dir, f))
  } catch {
    return []
  }
}

export function readTeamMemoryFile(filename: string): string | null {
  if (!filename || filename === '.' || filename === '..' || /[/\\]/.test(filename) || isAbsolute(filename) || filename.toLowerCase() === '.git') return null
  const path = join(getTeamMemoryDir(), filename)
  try {
    const rel = relative(realpathSync(getTeamMemoryDir()), realpathSync(path))
    if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) return null
    return statSync(path).isFile() ? readFileSync(path, 'utf8') : null
  } catch {
    return null
  }
}

function isTeamConfig(value: unknown): value is TeamMemoryConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  return typeof config.remoteUrl === 'string' && config.remoteUrl.trim().length > 0
    && Array.isArray(config.files) && config.files.every(file => typeof file === 'string' && file.length > 0)
    && (config.branch === undefined || (typeof config.branch === 'string' && config.branch.length > 0 && !config.branch.startsWith('-')))
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatSyncResult(result: SyncResult): string {
  const lines: string[] = []

  if (result.success) {
    lines.push('✓ Team memory sync successful')
  } else {
    lines.push('✗ Team memory sync failed')
  }

  if (result.pushed.length > 0) {
    lines.push(`Pushed (${result.pushed.length}):`)
    for (const f of result.pushed) lines.push(`  ↑ ${f}`)
  }

  if (result.pulled.length > 0) {
    lines.push(`Pulled (${result.pulled.length}):`)
    for (const f of result.pulled) lines.push(`  ↓ ${f}`)
  }

  if (result.secretsDetected > 0) {
    lines.push(`⚠ ${result.secretsDetected} secret(s) detected and redacted`)
  }

  for (const w of result.warnings) lines.push(`  ⚠ ${w}`)
  for (const e of result.errors) lines.push(`  ✗ ${e}`)

  return lines.join('\n')
}

export function formatTeamMemoryStatus(): string {
  const config = loadTeamConfig()
  if (!config) {
    return 'Team memory not configured. Use /team-memory init <remote-url>'
  }

  const initialized = isTeamMemoryInitialized()
  const files = listTeamMemoryFiles()

  const lines: string[] = [
    'Team Memory Status:',
    `  Remote: ${config.remoteUrl}`,
    `  Branch: ${config.branch ?? 'main'}`,
    `  Initialized: ${initialized ? '✓' : '✗'}`,
    `  Synced files: ${files.length}`,
    `  Auto-sync: ${config.autoSync ? 'enabled' : 'disabled'}`,
  ]

  if (config.files.length > 0) {
    lines.push(`  Local files:`)
    for (const f of config.files) {
      const exists = existsSync(f)
      lines.push(`    ${exists ? '✓' : '✗'} ${f}`)
    }
  }

  return lines.join('\n')
}
