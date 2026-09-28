import { execFile, execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'

export interface ProcessIdentity {
  pid: number
  hostname: string
  birthId: string
}

export type ProcessIdentityStatus = 'matching' | 'dead' | 'mismatch' | 'unknown'

let self: ProcessIdentity | null = null
const host = hostname()

function command(pid: number): string {
  return `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`
}

function linuxBirth(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
  const start = fields[19]
  if (!/^\d+$/.test(start ?? '')) throw new Error('Invalid process birth identity')
  return `${readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()}:${start}`
}

function result(pid: number, birthId: string): ProcessIdentity | null {
  if (!birthId) return null
  const identity = { pid, hostname: host, birthId }
  if (pid === process.pid) self = identity
  return identity
}

export function captureProcessIdentitySync(pid = process.pid): ProcessIdentity | null {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (pid === process.pid && self) return { ...self }
  try {
    if (process.platform === 'linux') return result(pid, linuxBirth(pid))
    if (process.platform === 'win32') {
      return result(pid, execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command(pid)], {
        encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
      }).trim())
    }
  } catch { return null }
  return null
}

export async function captureProcessIdentity(pid = process.pid): Promise<ProcessIdentity | null> {
  if (!Number.isInteger(pid) || pid <= 0) return null
  if (pid === process.pid && self) return { ...self }
  if (process.platform !== 'win32') return captureProcessIdentitySync(pid)
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command(pid)], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4096,
    }, (error, stdout) => resolve(error ? null : result(pid, stdout.trim())))
  })
}

function probe(identity: ProcessIdentity): ProcessIdentityStatus | undefined {
  if (!identity || !Number.isInteger(identity.pid) || identity.pid <= 0 || identity.hostname !== host || typeof identity.birthId !== 'string' || !identity.birthId) return 'unknown'
  try { process.kill(identity.pid, 0) } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'
  }
  return undefined
}

export function inspectProcessIdentitySync(identity: ProcessIdentity): ProcessIdentityStatus {
  const status = probe(identity)
  if (status) return status
  const actual = captureProcessIdentitySync(identity.pid)
  if (!actual) return probe(identity) ?? 'unknown'
  return actual.birthId === identity.birthId ? 'matching' : 'mismatch'
}

export async function inspectProcessIdentity(identity: ProcessIdentity): Promise<ProcessIdentityStatus> {
  const status = probe(identity)
  if (status) return status
  const actual = await captureProcessIdentity(identity.pid)
  if (!actual) return probe(identity) ?? 'unknown'
  return actual.birthId === identity.birthId ? 'matching' : 'mismatch'
}
