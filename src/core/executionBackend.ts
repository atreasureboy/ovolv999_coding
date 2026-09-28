import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'

export interface ExecutionProfile {
  mode: 'trusted-local' | 'isolated-worker'
  envAllowlist?: readonly string[]
  maxProcesses?: number
}

const active = new Set<ChildProcess>()
interface ProcessScope { pending: Set<Promise<void>>; parent?: ProcessScope; profile?: ExecutionProfile }
const scopes = new AsyncLocalStorage<ProcessScope>()

export function registerPhysicalResource(settled: Promise<void>): void {
  let scope = scopes.getStore()
  while (scope) {
    const pending = scope.pending
    pending.add(settled)
    void settled.then(() => pending.delete(settled), () => undefined)
    scope = scope.parent
  }
}

export function createProcessScope(profile?: ExecutionProfile): { pending: Set<Promise<void>>; run<T>(operation: () => Promise<T>): Promise<T> } {
  const parent = scopes.getStore()
  const scope: ProcessScope = { pending: new Set(), parent, profile: profile ?? parent?.profile }
  return { pending: scope.pending, run: operation => scopes.run(scope, operation) }
}

export function assertExecutionProfile(profile?: ExecutionProfile): void {
  if (profile?.mode === 'isolated-worker') throw new Error(`Process isolation is unavailable on ${process.platform}; isolated-worker execution refused`)
  if (profile?.maxProcesses !== undefined && (!Number.isSafeInteger(profile.maxProcesses) || profile.maxProcesses < 1)) throw new Error('Invalid process capacity')
}

export function getExecutionHealth(): { activeProcesses: number } {
  return { activeProcesses: active.size }
}

export function spawnManaged(executable: string, args: readonly string[] = [], options: SpawnOptions & { profile?: ExecutionProfile } = {}): ChildProcess {
  const { profile: configured, ...spawnOptions } = options
  const profile = configured ?? scopes.getStore()?.profile
  assertExecutionProfile(profile)
  if (active.size >= (profile?.maxProcesses ?? 64)) throw new Error('Host process capacity exceeded')
  const source = spawnOptions.env ?? process.env
  const allowed = profile?.envAllowlist && new Set(profile.envAllowlist.map(key => process.platform === 'win32' ? key.toLowerCase() : key))
  const env = allowed ? Object.fromEntries(Object.entries(source).filter(([key]) => allowed.has(process.platform === 'win32' ? key.toLowerCase() : key))) : source
  const child = spawn(executable, [...args], { ...spawnOptions, env })
  active.add(child)
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => { if (!child.pid) resolve() }) })
  registerPhysicalResource(closed)
  child.once('close', () => active.delete(child))
  child.once('error', () => { if (!child.pid) active.delete(child) })
  return child
}

export function execManaged(executable: string, args: readonly string[], options: SpawnOptions & { profile?: ExecutionProfile; maxBuffer?: number; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const { maxBuffer = 1024 * 1024, timeoutMs = 30_000, ...spawnOptions } = options
    const child = spawnManaged(executable, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let error: Error | undefined
    const timer = setTimeout(() => { error = new Error('Process execution deadline exceeded'); child.kill() }, timeoutMs)
    const consume = (data: Buffer, target: 'stdout' | 'stderr'): void => {
      bytes += data.length
      if (bytes > maxBuffer) { error = new Error('Process output byte limit exceeded'); child.kill(); return }
      if (target === 'stdout') stdout += data.toString(); else stderr += data.toString()
    }
    child.stdout?.on('data', data => consume(data as Buffer, 'stdout'))
    child.stderr?.on('data', data => consume(data as Buffer, 'stderr'))
    child.once('error', failure => { error = failure })
    child.once('close', code => {
      clearTimeout(timer)
      if (error || code !== 0) reject(Object.assign(error ?? new Error(`Process exited with code ${code}`), { stdout, stderr }))
      else resolve({ stdout, stderr })
    })
  })
}
