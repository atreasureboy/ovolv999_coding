/**
 * SSH Remote Sessions
 *
 * Execute agent operations on a remote machine via SSH. The remote
 * host must have ovolv999 (or at least Node.js) installed.
 *
 * Workflow:
 *   1. connect(host)              — verify SSH connectivity + tools
 *   2. syncUp(host, localPath)     — rsync local dir → remote
 *   3. runRemote(host, command)    — execute, stream stdout/stderr back
 *   4. syncDown(host, remotePath)  — rsync remote → local (fetch results)
 *   5. disconnect(host)            — cleanup
 *
 * Connection profiles are stored in ~/.ovolv999/ssh-profiles.json so
 * the user configures each host once. Supports SSH config inheritance
 * (~/.ssh/config), key-based auth, and jump hosts (ProxyJump).
 */

import { execFileSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, posix } from 'path'
import { homedir } from 'os'

// ── Types ───────────────────────────────────────────────────────────────────

export interface SshProfile {
  name: string
  host: string
  /** SSH user (default: current user) */
  user?: string
  /** SSH port (default: 22) */
  port?: number
  /** Identity file path */
  identityFile?: string
  /** Jump host (ProxyJump) */
  proxyJump?: string
  /** Remote working directory base */
  remoteBase?: string
  /** Known host fingerprint (optional, for verification) */
  knownHostFingerprint?: string
  /** Connection timeout (ms) */
  timeoutMs?: number
}

export interface SshExecResult {
  exitCode: number
  stdout: string
  stderr: string
  duration: number
}

export interface SshExecOptions {
  /** Working directory on the remote */
  cwd?: string
  /** Timeout (ms) */
  timeoutMs?: number
  /** Environment variables to set on the remote */
  env?: Record<string, string>
  /** Stream stdout/stderr line by line via callback */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
}

export interface SshConnectionTest {
  connected: boolean
  latency: number
  version?: string
  error?: string
}

// ── Profile Storage ─────────────────────────────────────────────────────────

function getProfilesPath(): string {
  return join(homedir(), '.ovolv999', 'ssh-profiles.json')
}

export function loadProfiles(): SshProfile[] {
  const path = getProfilesPath()
  if (!existsSync(path)) return []
  try {
    const profiles: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(profiles) ? profiles.filter(isSshProfile) : []
  } catch {
    return []
  }
}

export function saveProfiles(profiles: SshProfile[]): void {
  const path = getProfilesPath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(profiles, null, 2))
}

export function getProfile(name: string): SshProfile | undefined {
  return loadProfiles().find((p) => p.name === name)
}

export function addProfile(profile: SshProfile): SshProfile[] {
  const profiles = loadProfiles().filter((p) => p.name !== profile.name)
  profiles.push(profile)
  saveProfiles(profiles)
  return profiles
}

export function removeProfile(name: string): boolean {
  const profiles = loadProfiles()
  const filtered = profiles.filter((p) => p.name !== name)
  if (filtered.length === profiles.length) return false
  saveProfiles(filtered)
  return true
}

// ── SSH Command Building ────────────────────────────────────────────────────

export function buildSshArgs(profile: SshProfile, remoteCommand?: string): string[] {
  if (!isSshProfile(profile)) throw new Error('Invalid SSH profile')
  const args: string[] = []

  if (profile.port) args.push('-p', String(profile.port))
  if (profile.identityFile) args.push('-i', profile.identityFile)
  if (profile.proxyJump) args.push('-J', profile.proxyJump)

  // BatchMode for non-interactive, StrictHostKeyChecking accept-new
  args.push('-o', 'BatchMode=yes')
  args.push('-o', 'StrictHostKeyChecking=accept-new')
  args.push('-o', `ConnectTimeout=${Math.floor((profile.timeoutMs ?? 10000) / 1000)}`)

  // Target
  const target = profile.user ? `${profile.user}@${profile.host}` : profile.host
  args.push('--', target)

  if (remoteCommand) args.push(remoteCommand)

  return args
}

function buildRsyncArgs(
  profile: SshProfile,
  src: string,
  dst: string,
  direction: 'up' | 'down',
): string[] {
  const args: string[] = ['-avz', '--delete']

  // Rsync uses -e to specify the remote shell
  const sshArgs = buildSshArgs(profile).slice(0, -2)
  args.push('-e', `ssh ${sshArgs.map(shellQuote).join(' ')}`, '--')

  const remoteTarget = targetStr(profile)
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'

  if (direction === 'up') {
    args.push(src + '/', `${remoteTarget}:${posix.join(remoteBase, dst)}`)
  } else {
    args.push(`${remoteTarget}:${posix.join(remoteBase, src)}/`, dst)
  }

  return args
}

function targetStr(profile: SshProfile): string {
  return profile.user ? `${profile.user}@${profile.host}` : profile.host
}

// ── Connection Test ─────────────────────────────────────────────────────────

export function testConnection(profile: SshProfile): SshConnectionTest {
  const start = Date.now()
  try {
    const args = buildSshArgs(profile, 'echo "__OVOGV999_SSH_OK__"; node --version 2>/dev/null || echo "no-node"')
    const result = execFileSync('ssh', args, {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: profile.timeoutMs ?? 10000,
    })
    const latency = Date.now() - start

    if (result.includes('__OVOGV999_SSH_OK__')) {
      const versionMatch = result.match(/v(\d+\.\d+\.\d+)/)
      return {
        connected: true,
        latency,
        version: versionMatch ? `node ${versionMatch[0]}` : 'no-node',
      }
    }
    return { connected: false, latency, error: 'Unexpected response' }
  } catch (err) {
    return {
      connected: false,
      latency: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Remote Execution ────────────────────────────────────────────────────────

export function execRemote(profile: SshProfile, command: string, options: SshExecOptions = {}): SshExecResult {
  const start = Date.now()

  // Build the remote command with optional cwd + env
  let remoteCmd = command
  if (options.cwd) {
    remoteCmd = `cd ${remotePathQuote(options.cwd)} && ${remoteCmd}`
  }
  if (options.env) {
    if (Object.entries(options.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string')) {
      return { exitCode: 1, stdout: '', stderr: 'Invalid remote environment variable', duration: Date.now() - start }
    }
    const envPrefix = Object.entries(options.env)
      .map(([k, v]) => `${k}=${shellQuote(v)}`)
      .join(' ')
    if (envPrefix) remoteCmd = `export ${envPrefix}; ${remoteCmd}`
  }

  const execOptions = {
    encoding: 'utf8' as const,
    stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 120000,
  }

  try {
    const stdout = execFileSync('ssh', buildSshArgs(profile, remoteCmd), execOptions)

    // Stream lines if callbacks provided
    if (options.onStdout) {
      for (const line of stdout.split('\n')) {
        if (line) options.onStdout(line)
      }
    }

    return {
      exitCode: 0,
      stdout,
      stderr: '',
      duration: Date.now() - start,
    }
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message: string }
    const stdout = e.stdout?.toString() ?? ''
    const stderr = e.stderr?.toString() ?? e.message
    if (options.onStderr && e.stderr) {
      for (const line of stderr.split('\n')) {
        if (line) options.onStderr(line)
      }
    }
    return {
      exitCode: e.status ?? 1,
      stdout,
      stderr,
      duration: Date.now() - start,
    }
  }
}

// ── File Sync ───────────────────────────────────────────────────────────────

export function syncUp(profile: SshProfile, localPath: string, remoteSubdir: string = '.'): boolean {
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'
  // Ensure remote base exists
  if (execRemote(profile, `mkdir -p ${remotePathQuote(remoteBase)}`).exitCode !== 0) return false
  try {
    execFileSync('rsync', buildRsyncArgs(profile, localPath, remoteSubdir, 'up'), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
    })
    return true
  } catch {
    return false
  }
}

export function syncDown(profile: SshProfile, remoteSubdir: string, localPath: string): boolean {
  try {
    execFileSync('rsync', buildRsyncArgs(profile, remoteSubdir, localPath, 'down'), {
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 120000,
    })
    return true
  } catch {
    return false
  }
}

// ── Remote Agent Session ────────────────────────────────────────────────────

export interface RemoteAgentOptions {
  task: string
  syncBefore?: boolean
  syncAfter?: boolean
  model?: string
  timeoutMs?: number
  onOutput?: (line: string) => void
}

export interface RemoteAgentResult {
  success: boolean
  output: string
  duration: number
  syncedUp: boolean
  syncedDown: boolean
}

/**
 * Run a full agent task on the remote host. Optionally syncs the
 * working directory up before and down after.
 */
export function runRemoteAgent(profile: SshProfile, options: RemoteAgentOptions): RemoteAgentResult {
  const start = Date.now()
  const remoteBase = profile.remoteBase ?? '~/ovolv999-remote'
  let syncedUp = false
  let syncedDown = false

  // Sync up
  if (options.syncBefore) {
    syncedUp = syncUp(profile, '.', '.')
    if (!syncedUp) return { success: false, output: 'Remote upload failed; agent was not started', duration: Date.now() - start, syncedUp, syncedDown }
  }

  // Build the remote ovolv999 command
  let cmd = 'ovolv999'
  if (options.model) cmd += ` --model ${shellQuote(options.model)}`
  cmd += ` --pipe`  // non-interactive
  cmd += ` ${shellQuote(options.task)}`

  const result = execRemote(profile, cmd, {
    cwd: remoteBase,
    timeoutMs: options.timeoutMs ?? 600000,
    onStdout: options.onOutput,
    onStderr: options.onOutput,
  })

  // Sync down
  if (options.syncAfter) {
    syncedDown = syncDown(profile, '.', '.')
  }

  return {
    success: result.exitCode === 0 && (!options.syncAfter || syncedDown),
    output: result.stdout + (result.stderr ? '\n' + result.stderr : '') + (options.syncAfter && !syncedDown ? '\nRemote download failed' : ''),
    duration: Date.now() - start,
    syncedUp,
    syncedDown,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatProfile(profile: SshProfile): string {
  const lines = [
    `SSH Profile: ${profile.name}`,
    `  Host: ${profile.host}`,
  ]
  if (profile.user) lines.push(`  User: ${profile.user}`)
  if (profile.port) lines.push(`  Port: ${profile.port}`)
  if (profile.identityFile) lines.push(`  Key: ${profile.identityFile}`)
  if (profile.proxyJump) lines.push(`  ProxyJump: ${profile.proxyJump}`)
  if (profile.remoteBase) lines.push(`  Remote base: ${profile.remoteBase}`)
  return lines.join('\n')
}

export function formatProfileList(profiles: SshProfile[]): string {
  if (profiles.length === 0) return 'No SSH profiles configured.'
  const lines = ['SSH profiles:']
  for (const p of profiles) {
    const target = p.user ? `${p.user}@${p.host}` : p.host
    const port = p.port ? `:${p.port}` : ''
    lines.push(`  ${p.name} → ${target}${port}`)
  }
  return lines.join('\n')
}

export function formatConnectionTest(test: SshConnectionTest): string {
  if (test.connected) {
    return `Connected (${test.latency}ms)${test.version ? ` — ${test.version}` : ''}`
  }
  return `Connection failed (${test.latency}ms): ${test.error ?? 'unknown error'}`
}

export function formatExecResult(result: SshExecResult): string {
  const lines = [
    `Exit code: ${result.exitCode}`,
    `Duration: ${result.duration}ms`,
  ]
  if (result.stdout) lines.push('', 'stdout:', result.stdout.trimEnd())
  if (result.stderr) lines.push('', 'stderr:', result.stderr.trimEnd())
  return lines.join('\n')
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shellQuote(s: string): string {
  if (s === '') return "''"
  if (/^[A-Za-z0-9_:.@/=-]+$/.test(s)) return s
  return `'${s.replace(/'/g, "'\\''")}'`
}

function remotePathQuote(path: string): string {
  if (path === '~') return '"$HOME"'
  if (path.startsWith('~/')) return `"$HOME"/${shellQuote(path.slice(2))}`
  return shellQuote(path)
}

function isSshProfile(value: unknown): value is SshProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const profile = value as Record<string, unknown>
  if (typeof profile.name !== 'string' || !profile.name.trim() || typeof profile.host !== 'string' || !profile.host || /^-|\s/.test(profile.host) || [...profile.host].some(char => char.charCodeAt(0) < 32)) return false
  if (profile.user !== undefined && (typeof profile.user !== 'string' || !profile.user || /^-|\s|@/.test(profile.user) || [...profile.user].some(char => char.charCodeAt(0) < 32))) return false
  if (profile.port !== undefined && (!Number.isInteger(profile.port) || Number(profile.port) < 1 || Number(profile.port) > 65535)) return false
  if (profile.timeoutMs !== undefined && (typeof profile.timeoutMs !== 'number' || !Number.isFinite(profile.timeoutMs) || profile.timeoutMs < 1000)) return false
  return ['identityFile', 'proxyJump', 'remoteBase', 'knownHostFingerprint'].every(key => profile[key] === undefined || typeof profile[key] === 'string')
}
