import { spawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { AsyncLocalStorage } from 'async_hooks'
import { StringDecoder } from 'string_decoder'
import { captureProcessIdentity, inspectProcessIdentity } from './processIdentity.js'
import { captureOwnedProcessTree, captureOwnedProcessTreeFromPid, mergeOwnedProcessTrees, OwnedProcessTreeCaptureError, stopOwnedProcessTree, type OwnedProcessTree } from './processTree.js'
import { assertSupportedExecutionPolicy, buildChildEnvironment, resolveManagedExecutionPolicy, type ExecutionPolicy } from './executionPolicy.js'
import { spawnManagedChildProcess, type ManagedChildProcess } from './managedChildProcess.js'
import { settleWithin } from './outcome.js'

export interface ExecutionProfile {
  mode: 'trusted-local' | 'isolated-worker'
  envAllowlist?: readonly string[]
  maxProcesses?: number
}

const active = new Set<ChildProcess>()
interface ProcessScope { pending: Set<Promise<void>>; parent?: ProcessScope; policy?: ExecutionPolicy }
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

export function createProcessScope(profile?: ExecutionProfile, policy?: ExecutionPolicy): { pending: Set<Promise<void>>; run<T>(operation: () => Promise<T>): Promise<T> } {
  const parent = scopes.getStore()
  const effective = profile === undefined && policy === undefined ? parent?.policy : resolveManagedExecutionPolicy(profile, policy ?? parent?.policy, process.cwd())
  const scope: ProcessScope = { pending: new Set(), parent, policy: effective }
  return { pending: scope.pending, run: operation => scopes.run(scope, operation) }
}

export function currentExecutionPolicy(cwd = process.cwd()): ExecutionPolicy {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) if (scope.policy) assertSupportedExecutionPolicy(scope.policy)
  const policy = resolveManagedExecutionPolicy(undefined, scopes.getStore()?.policy, cwd)
  for (let scope = scopes.getStore()?.parent; scope; scope = scope.parent) if (scope.policy) {
    const inherited = scope.policy
    if (inherited.mode === 'isolated-worker') policy.mode = inherited.mode
    for (const key of ['readableRoots', 'writableRoots', 'deniedPaths'] as const) policy[key] = [...new Set([...policy[key], ...inherited[key]])]
    if (inherited.network === 'deny' || policy.network === 'deny') {
      policy.network = 'deny'
      policy.allowedHosts = []
    } else if (inherited.network === 'allowlist') {
      policy.allowedHosts = policy.network === 'allowlist' ? policy.allowedHosts.filter(host => inherited.allowedHosts.includes(host)) : [...inherited.allowedHosts]
      policy.network = policy.allowedHosts.length ? 'allowlist' : 'deny'
    }
    policy.limits.processes = Math.min(policy.limits.processes, inherited.limits.processes)
    for (const key of ['memoryBytes', 'cpuMs'] as const) if (inherited.limits[key] !== undefined) policy.limits[key] = Math.min(policy.limits[key] ?? inherited.limits[key], inherited.limits[key])
  }
  return policy
}

export function assertExecutionProfile(profile?: ExecutionProfile): void {
  assertSupportedExecutionPolicy(resolveManagedExecutionPolicy(profile, undefined, process.cwd()))
}

export function getExecutionHealth(): { activeProcesses: number } {
  return { activeProcesses: active.size }
}

export function isManagedChild(child: ChildProcess): child is ManagedChildProcess {
  return 'physicallySettled' in child && child.physicallySettled instanceof Promise
}

export function spawnManaged(executable: string, args: readonly string[] = [], options: SpawnOptions & { profile?: ExecutionProfile; policy?: ExecutionPolicy } = {}): ChildProcess {
  const { profile, policy: configured, ...spawnOptions } = options
  const cwd = typeof spawnOptions.cwd === 'string' ? spawnOptions.cwd : process.cwd()
  const policy = resolveManagedExecutionPolicy(profile, configured ?? scopes.getStore()?.policy, cwd)
  assertSupportedExecutionPolicy(policy)
  let capacity = policy.limits.processes
  for (let scope = scopes.getStore(); scope; scope = scope.parent) if (scope.policy) {
    assertSupportedExecutionPolicy(scope.policy)
    capacity = Math.min(capacity, scope.policy.limits.processes)
  }
  if (active.size >= capacity) throw new Error('Host process capacity exceeded')
  const source = spawnOptions.env ?? process.env
  const env = buildChildEnvironment(policy, source)
  const ipc = Array.isArray(spawnOptions.stdio) && spawnOptions.stdio.includes('ipc')
  let target = executable
  let argv = [...args]
  let nativeOptions = { ...spawnOptions, cwd, env, policy }
  if (process.platform === 'win32' && !ipc && spawnOptions.shell) {
    target = typeof spawnOptions.shell === 'string' ? spawnOptions.shell : env.COMSPEC ?? env.ComSpec ?? 'cmd.exe'
    const command = [executable, ...args].join(' ')
    const cmd = /(?:^|[\\/])cmd(?:\.exe)?$/i.test(target)
    argv = cmd ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command]
    nativeOptions = { ...nativeOptions, shell: false, windowsVerbatimArguments: cmd }
  }
  const child = process.platform === 'win32' && !ipc ? spawnManagedChildProcess(target, argv, nativeOptions) : spawn(executable, [...args], { ...spawnOptions, env })
  if (!isManagedChild(child)) Object.defineProperty(child, 'accounting', { value: 'observed-only' })
  active.add(child)
  const closed = isManagedChild(child) ? child.physicallySettled : new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => { if (!child.pid) resolve() }) })
  registerPhysicalResource(closed)
  void closed.then(() => active.delete(child))
  return child
}

export function execManaged(executable: string, args: readonly string[], options: SpawnOptions & { profile?: ExecutionProfile; policy?: ExecutionPolicy; maxBuffer?: number; timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
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
    if (isManagedChild(child)) void child.physicallySettled.then(releasePhysical)
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
        if (isManagedChild(child)) {
          child.kill('SIGKILL')
          await settleWithin((async () => {
            if (child.managedProcess) await child.managedProcess.stop(reason.message)
            await child.physicallySettled
          })(), 2500)
          return true
        }
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
      if (isManagedChild(child)) return
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
    child.once('error', failure => {
      error = failure
      if (isManagedChild(child) && child.physicalState === 'unknown') finish(null, false)
    })
    child.once('close', code => {
      closed = true
      clearTimeout(trackingTimer)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (!stopPromise) {
        stopPromise = (async () => {
          if (isManagedChild(child)) { await child.physicallySettled; return true }
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
