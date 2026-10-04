import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'
import { StringDecoder } from 'string_decoder'
import { captureProcessIdentity, inspectProcessIdentity } from './processIdentity.js'
import { captureOwnedProcessTree, captureOwnedProcessTreeFromPid, mergeOwnedProcessTrees, OwnedProcessTreeCaptureError, stopOwnedProcessTree, type OwnedProcessTree } from './processTree.js'

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
    const { maxBuffer = 1024 * 1024, timeoutMs = 30_000, signal, ...spawnOptions } = options
    signal?.throwIfAborted()
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid managed execution limit')
    const child = spawnManaged(executable, args, { detached: process.platform !== 'win32', ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let error: Error | undefined
    let closed = false
    let finished = false
    let stopPromise: Promise<boolean> | undefined
    let tree: OwnedProcessTree | undefined
    let tracking: Promise<void> = Promise.resolve()
    let trackingTimer: NodeJS.Timeout | undefined
    let unverifiedDescendants = false
    let releasePhysical!: () => void
    registerPhysicalResource(new Promise<void>(resolvePhysical => { releasePhysical = resolvePhysical }))
    const finish = (code: number | null, confirmed = true): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(trackingTimer)
      signal?.removeEventListener('abort', abort)
      if (confirmed) releasePhysical()
      if (error || code !== 0) reject(Object.assign(error ?? new Error(`Process exited with code ${code}`), { stdout, stderr, status: code, ...(!confirmed ? { unfinishedResources: [`process ${child.pid ?? 'unknown'}`] } : {}) }))
      else resolve({ stdout, stderr })
    }
    const stop = (reason: Error): void => {
      if (stopPromise || finished) return
      error = reason
      clearTimeout(trackingTimer)
      stopPromise = (async () => {
        if (!child.pid) return true
        await tracking
        const identity = tree?.root ?? await captureProcessIdentity(child.pid)
        if (!identity) throw new Error('Managed process birth identity is unavailable; termination cannot be confirmed')
        if (!closed && await inspectProcessIdentity(identity) === 'matching') {
          tree = mergeOwnedProcessTrees(tree, await captureOwnedProcessTree(identity, spawnOptions.detached ?? process.platform !== 'win32'))
        }
        if (!tree) throw new Error('Managed process exited before owned resources could be discovered; termination cannot be confirmed')
        const result = await stopOwnedProcessTree(tree, 0, 2500)
        if (!result.stopped) throw new Error(result.reason ?? 'Managed process termination could not be confirmed')
        if (unverifiedDescendants) throw new Error('Managed descendant birth identities could not be verified; termination cannot be confirmed')
        return true
      })().catch(failure => {
        stderr += `\n${failure instanceof Error ? failure.message : String(failure)}`
        return false
      })
      void stopPromise.then(confirmed => { if (!confirmed) finish(null, false) })
    }
    const abort = (): void => stop(signal?.reason instanceof Error ? signal.reason : new Error('Managed process execution cancelled'))
    const timer = setTimeout(() => stop(new Error('Process execution deadline exceeded')), timeoutMs)
    const trackTree = (): void => {
      tracking = (async () => {
        if (!child.pid) return
        const current = await captureOwnedProcessTreeFromPid(child.pid, spawnOptions.detached ?? process.platform !== 'win32')
        if (current) tree = mergeOwnedProcessTrees(tree, current)
      })().catch(failure => {
        if (failure instanceof OwnedProcessTreeCaptureError) {
          tree = mergeOwnedProcessTrees(tree, failure.tree)
          unverifiedDescendants ||= failure.hasUnverifiedDescendants
        }
      })
      void tracking.then(() => {
        if (closed || stopPromise || finished) return
        trackingTimer = setTimeout(trackTree, 250)
        trackingTimer.unref()
      })
    }
    const consume = (data: Buffer, target: 'stdout' | 'stderr'): void => {
      bytes += data.length
      if (bytes > maxBuffer) { stop(new Error('Process output byte limit exceeded')); return }
      if (target === 'stdout') stdout += stdoutDecoder.write(data); else stderr += stderrDecoder.write(data)
    }
    child.stdout?.on('data', data => consume(data as Buffer, 'stdout'))
    child.stderr?.on('data', data => consume(data as Buffer, 'stderr'))
    child.once('error', failure => { error = failure })
    child.once('close', code => {
      closed = true
      clearTimeout(trackingTimer)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (!stopPromise) {
        stopPromise = (async () => {
          await tracking
          if (tree) {
            const states = await Promise.all(tree.members.map(inspectProcessIdentity))
            if (states.includes('unknown')) throw new Error('Managed owned descendant identity cannot be verified after root exit')
            if (states.includes('matching')) {
              error ??= new Error('Managed process exited with surviving owned descendants')
              const result = await stopOwnedProcessTree(tree, 0, 2500)
              if (!result.stopped) throw new Error(result.reason ?? 'Managed owned descendants could not be stopped')
            }
          }
          if (unverifiedDescendants) throw new Error('Managed descendant birth identities could not be verified after root exit')
          return true
        })().catch(failure => {
          error ??= failure instanceof Error ? failure : new Error(String(failure))
          stderr += `\n${failure instanceof Error ? failure.message : String(failure)}`
          return false
        })
      }
      void stopPromise.then(confirmed => finish(code, confirmed))
    })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    if (!stopPromise) trackTree()
  })
}
