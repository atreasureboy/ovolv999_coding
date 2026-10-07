import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PassThrough, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { assertSupportedExecutionPolicy, buildChildEnvironment, resolveExecutionPolicy, type ExecutionPolicy } from './executionPolicy.js'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { captureOwnedProcessTree, mergeOwnedProcessTrees, OwnedProcessTreeCaptureError, stopOwnedProcessTree, type OwnedProcessTree } from './processTree.js'

export interface ManagedProcess {
  readonly id: string
  readonly accounting: 'contained' | 'observed-only'
  readonly pid: number | undefined
  readonly identity: ProcessIdentity | undefined
  readonly controllerPid: number | undefined
  readonly state: 'starting' | 'running' | 'exited' | 'unknown' | 'settled'
  readonly failure: Error | undefined
  readonly failed: Promise<Error>
  readonly stdin: Writable | null
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly exited: Promise<{ exitCode: number | null }>
  readonly physicallySettled: Promise<void>
  stop(reason: string): Promise<void>
  ref(): void
  unref(): void
}

export interface ManagedProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  policy: ExecutionPolicy
  signal?: AbortSignal
  helperPath?: string
  windowsVerbatimArguments?: boolean
}

const active = new Map<string, ManagedProcess>()
const protocolVersion = 1
const frameLimit = 1024 * 1024
const outputBufferLimit = 1024 * 1024

export function getManagedProcessHealth(): { activeProcesses: number; contained: number; observedOnly: number; unknown: number } {
  return {
    activeProcesses: active.size,
    contained: [...active.values()].filter(process => process.accounting === 'contained').length,
    observedOnly: [...active.values()].filter(process => process.accounting === 'observed-only').length,
    unknown: [...active.values()].filter(process => process.state === 'unknown').length,
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let complete!: (value: T) => void
  let fail!: (error: Error) => void
  const promise = new Promise<T>((resolve, reject) => { complete = resolve; fail = reject })
  return { promise, resolve: complete, reject: fail }
}

function checkedExecutable(executable: string, env: NodeJS.ProcessEnv): string {
  if (!executable || executable.includes('\0')) throw new Error('Invalid managed executable')
  if (isAbsolute(executable) || executable.includes('/') || executable.includes('\\')) return resolve(executable)
  const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
  const extensions = process.platform === 'win32' ? ['', '.exe', '.com'] : ['']
  for (const directory of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, executable + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('Managed executable was not found in the reviewed child PATH')
}

function checkedHelper(path?: string): string {
  const helper = path ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../native/execution-host/bin/execution-host.exe')
  const manifestPath = join(dirname(helper), 'manifest.json')
  if (!existsSync(helper) || !existsSync(manifestPath)) throw new Error('Windows execution host or its integrity manifest is unavailable; execution refused')
  const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid execution host integrity manifest')
  const manifest = value as Record<string, unknown>
  if (manifest.protocolVersion !== protocolVersion || manifest.platform !== 'win32' || manifest.architecture !== process.arch || manifest.sha256 !== createHash('sha256').update(readFileSync(helper)).digest('hex')) throw new Error('Execution host version, platform, or integrity mismatch; execution refused')
  return helper
}

export async function spawnManagedProcess(executable: string, args: readonly string[], options: ManagedProcessOptions): Promise<ManagedProcess> {
  options.signal?.throwIfAborted()
  if (!isAbsolute(options.cwd) || args.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Invalid managed process cwd or arguments')
  const policy = resolveExecutionPolicy(options.policy, options.cwd)
  assertSupportedExecutionPolicy(policy)
  if (active.size >= policy.limits.processes) throw new Error('Managed process physical capacity exceeded')
  const env = buildChildEnvironment(policy, options.env)
  const worker = checkedExecutable(executable, env)
  return process.platform === 'win32' ? startWindows(worker, args, { ...options, env, policy }, checkedHelper(options.helperPath)) : startObserved(worker, args, { ...options, env, policy })
}

async function startWindows(executable: string, args: readonly string[], options: ManagedProcessOptions, helper: string): Promise<ManagedProcess> {
  const id = randomUUID()
  const started = deferred<ManagedProcess>()
  const exited = deferred<{ exitCode: number | null }>()
  const physicallySettled = deferred<void>()
  const failed = deferred<Error>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const controller = spawn(helper, [], { cwd: options.cwd, env: options.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let state: ManagedProcess['state'] = 'starting'
  let accounting: ManagedProcess['accounting'] = 'observed-only'
  let identity: ProcessIdentity | undefined
  let failure: Error | undefined
  let sequence = 0
  let rootExited = false
  let containmentSettled = false
  let helperClosed = false
  let helloReceived = false
  let outputOverflow = false
  let stopPromise: Promise<void> | undefined
  let stopRequest: { frame: Record<string, unknown>; callback: (error?: Error | null) => void } | undefined
  let pending = ''
  let pendingBytes = 0
  const decoder = new StringDecoder('utf8')
  const acknowledgements = new Map<number, (error?: Error | null) => void>()
  const send = (frame: Record<string, unknown>, callback?: (error?: Error | null) => void): void => {
    const data = JSON.stringify({ version: protocolVersion, id, ...frame }) + '\n'
    if (Buffer.byteLength(data) > frameLimit) { callback?.(new Error('Managed control frame byte limit exceeded')); return }
    controller.stdin.write(data, callback)
  }
  const sendStop = (): void => {
    if (!helloReceived || !stopRequest) return
    const request = stopRequest
    stopRequest = undefined
    send(request.frame, request.callback)
  }
  const unknown = (error: Error): void => {
    failure ??= error
    failed.resolve(failure)
    if (state === 'settled') return
    state = 'unknown'
    started.reject(Object.assign(error, { managedProcess: handle }))
    for (const callback of acknowledgements.values()) callback(error)
    acknowledgements.clear()
  }
  const settle = (): void => {
    if (!containmentSettled || !helperClosed) return
    state = 'settled'
    clearTimeout(startupTimer)
    options.signal?.removeEventListener('abort', abort)
    stdout.end()
    stderr.end()
    active.delete(id)
    physicallySettled.resolve()
  }
  const stdin = new Writable({
    highWaterMark: 65536,
    write(chunk: Buffer | string, encoding, callback) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
      if (state === 'unknown' || state === 'settled') { callback(failure ?? new Error('Managed input is closed')); return }
      let offset = 0
      const next = (error?: Error | null): void => {
        if (error || offset >= data.length) { callback(error); return }
        const part = data.subarray(offset, offset + 65536)
        offset += part.length
        const current = ++sequence
        acknowledgements.set(current, next)
        send({ type: 'stdin', sequence: current, data: part.toString('base64') }, failure => { if (failure) { acknowledgements.delete(current); next(failure) } })
      }
      next()
    },
    final(callback) {
      const current = ++sequence
      acknowledgements.set(current, callback)
      send({ type: 'stdinEnd', sequence: current }, error => { if (error) { acknowledgements.delete(current); callback(error) } })
    },
  })
  stdin.on('error', () => undefined)
  controller.stdin.on('error', error => unknown(error))
  const handle: ManagedProcess = {
    id,
    get accounting() { return accounting },
    get pid() { return identity?.pid },
    get identity() { return identity && { ...identity } },
    get controllerPid() { return controller.pid },
    get state() { return state },
    get failure() { return failure },
    failed: failed.promise,
    stdin, stdout, stderr,
    exited: exited.promise,
    physicallySettled: physicallySettled.promise,
    stop(reason) {
      if (state === 'settled') return Promise.resolve()
      if (containmentSettled) return physicallySettled.promise
      if (helperClosed) return Promise.reject(failure ?? new Error('Execution host closed without settlement proof'))
      if (stopPromise) return stopPromise
      stopPromise = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Managed job termination remains unconfirmed')), 8000)
        physicallySettled.promise.then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) })
        stopRequest = { frame: { type: 'stop', reason: reason.slice(0, 256) }, callback: error => { if (error) { clearTimeout(timer); reject(error) } } }
        sendStop()
      })
      return stopPromise
    },
    ref() {
      controller.ref()
      for (const stream of controller.stdio) (stream as { ref?: () => void } | null)?.ref?.()
    },
    unref() {
      controller.unref()
      for (const stream of controller.stdio) (stream as { unref?: () => void } | null)?.unref?.()
    },
  }
  active.set(id, handle)
  const abort = (): void => { void handle.stop('cancelled').catch(error => unknown(error instanceof Error ? error : new Error(String(error)))) }
  const startupTimer = setTimeout(() => { unknown(new Error('Execution host startup deadline exceeded')); controller.stdin.destroy() }, 10000)
  const accept = (frame: Record<string, unknown>): void => {
    if (frame.version !== protocolVersion) throw new Error('Execution host protocol version mismatch')
    if (frame.type === 'hello' && !helloReceived && state === 'starting' && frame.implementation === 'windows-job-v1') {
      helloReceived = true
      if (stopRequest) sendStop()
      else send({ type: 'spawn', executable, args, cwd: options.cwd, env: options.env, processLimit: options.policy.limits.processes, windowsVerbatimArguments: options.windowsVerbatimArguments === true }, error => { if (error) unknown(error) })
      return
    }
    if (frame.id !== id) throw new Error('Execution host process identity mismatch')
    switch (frame.type) {
      case 'started':
        if (state !== 'starting' || !Number.isSafeInteger(frame.pid) || Number(frame.pid) < 1 || typeof frame.birthId !== 'string' || !/^\d+$/.test(frame.birthId) || frame.accounting !== 'contained' || frame.containment !== 'windows-job') throw new Error('Invalid execution host containment proof')
        identity = { pid: Number(frame.pid), birthId: frame.birthId, hostname: hostname() }
        accounting = 'contained'
        state = 'running'
        clearTimeout(startupTimer)
        started.resolve(handle)
        if (options.signal?.aborted) abort()
        break
      case 'stdout':
      case 'stderr': {
        if (typeof frame.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.data)) throw new Error('Invalid execution host output frame')
        if (outputOverflow) break
        const data = Buffer.from(frame.data, 'base64')
        const buffered = stdout.readableLength + stdout.writableLength + stderr.readableLength + stderr.writableLength
        if (buffered + data.length > outputBufferLimit) {
          outputOverflow = true
          unknown(new Error('Managed output buffer byte limit exceeded; worker stopped'))
          void handle.stop('output buffer byte limit exceeded').catch(error => unknown(error instanceof Error ? error : new Error(String(error))))
          break
        }
        const stream = frame.type === 'stdout' ? stdout : stderr
        stream.write(data)
        break
      }
      case 'stdinAck': {
        if (!Number.isSafeInteger(frame.sequence)) throw new Error('Invalid execution host input acknowledgement')
        const callback = acknowledgements.get(Number(frame.sequence))
        if (!callback) throw new Error('Unexpected execution host input acknowledgement')
        acknowledgements.delete(Number(frame.sequence))
        callback()
        break
      }
      case 'stdinError':
        for (const callback of acknowledgements.values()) callback(new Error(typeof frame.message === 'string' ? frame.message : 'Managed input failed'))
        acknowledgements.clear()
        break
      case 'exited':
        if (rootExited || !Number.isSafeInteger(frame.exitCode) || Number(frame.exitCode) < 0) throw new Error('Invalid execution host root exit')
        rootExited = true
        if (state !== 'unknown') state = 'exited'
        exited.resolve({ exitCode: Number(frame.exitCode) })
        break
      case 'settled':
        if (!rootExited || accounting !== 'contained' || frame.activeProcesses !== 0 || frame.containment !== 'windows-job') throw new Error('Invalid execution host physical settlement proof')
        containmentSettled = true
        settle()
        break
      case 'launchSettled':
        if (identity || state !== 'unknown' || frame.activeProcesses !== 0 || frame.launchFailed !== true) throw new Error('Invalid execution host failed-launch settlement proof')
        containmentSettled = true
        rootExited = true
        exited.resolve({ exitCode: null })
        settle()
        break
      case 'error':
        unknown(new Error(typeof frame.message === 'string' ? frame.message : 'Execution host failed'))
        break
      default:
        throw new Error('Unsupported execution host event')
    }
  }
  controller.stdout.on('data', (chunk: Buffer) => {
    pendingBytes += chunk.length
    pending += decoder.write(chunk)
    try {
      let newline: number
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline)
        if (Buffer.byteLength(line) > frameLimit) throw new Error('Execution host frame byte limit exceeded')
        pending = pending.slice(newline + 1)
        pendingBytes = Buffer.byteLength(pending)
        const value = JSON.parse(line) as unknown
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid execution host control event')
        accept(value as Record<string, unknown>)
      }
      if (pendingBytes > frameLimit) throw new Error('Execution host incomplete frame byte limit exceeded')
    } catch (error) { unknown(error instanceof Error ? error : new Error(String(error))); controller.stdin.destroy() }
  })
  controller.stderr.on('data', () => unknown(new Error('Unexpected execution host diagnostic stream')))
  controller.once('error', error => {
    unknown(error)
    if (!controller.pid) { containmentSettled = true; helperClosed = true; settle() }
  })
  controller.once('close', () => {
    helperClosed = true
    clearTimeout(startupTimer)
    if (!containmentSettled) unknown(new Error('Execution host closed without physical settlement proof'))
    settle()
  })
  options.signal?.addEventListener('abort', abort, { once: true })
  return started.promise
}

async function startObserved(executable: string, args: readonly string[], options: ManagedProcessOptions): Promise<ManagedProcess> {
  const id = randomUUID()
  const exited = deferred<{ exitCode: number | null }>()
  const physicallySettled = deferred<void>()
  const failed = deferred<Error>()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: ChildProcess = spawn(executable, [...args], { cwd: options.cwd, env: options.env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const rootIdentity: { value?: ProcessIdentity } = {}
  let state: ManagedProcess['state'] = 'starting'
  let failure: Error | undefined
  let tree: OwnedProcessTree | undefined
  let closed = false
  let unverified = false
  let stopped: Promise<void> | undefined
  let tracking = Promise.resolve()
  let trackingTimer: ReturnType<typeof setTimeout> | undefined
  const unknown = (error: Error): void => { failure ??= error; failed.resolve(failure); state = 'unknown' }
  const settle = (): void => {
    if (!closed || unverified || !tree) return
    state = 'settled'
    clearTimeout(trackingTimer)
    options.signal?.removeEventListener('abort', abort)
    active.delete(id)
    physicallySettled.resolve()
  }
  const handle: ManagedProcess = {
    id, accounting: 'observed-only',
    get pid() { return child.pid },
    get identity() { return rootIdentity.value && { ...rootIdentity.value } },
    controllerPid: undefined,
    get state() { return state },
    get failure() { return failure },
    failed: failed.promise,
    stdin: child.stdin, stdout, stderr,
    exited: exited.promise, physicallySettled: physicallySettled.promise,
    stop() {
      if (state === 'settled') return Promise.resolve()
      if (stopped) return stopped
      stopped = (async () => {
        await tracking
        if (!tree || unverified) throw new Error('Observed descendants are unverified; physical settlement remains pending')
        const result = await stopOwnedProcessTree(tree, 100, 5000)
        if (!result.stopped) throw new Error(result.reason ?? 'Observed process termination remains unconfirmed')
        await new Promise<void>(resolve => { if (closed) resolve(); else child.once('close', () => resolve()) })
        settle()
      })().catch(error => { unknown(error instanceof Error ? error : new Error(String(error))); throw error })
      return stopped
    },
    ref() { child.ref() },
    unref() { child.unref() },
  }
  active.set(id, handle)
  const abort = (): void => { void handle.stop('cancelled').catch(() => undefined) }
  const track = (): void => {
    tracking = (async () => {
      if (!rootIdentity.value) return
      try { tree = mergeOwnedProcessTrees(tree, await captureOwnedProcessTree(rootIdentity.value, true)) }
      catch (error) {
        if (error instanceof OwnedProcessTreeCaptureError) { tree = mergeOwnedProcessTrees(tree, error.tree); unverified ||= error.hasUnverifiedDescendants }
        else { unverified = true; unknown(error instanceof Error ? error : new Error(String(error))) }
      }
    })()
    void tracking.then(() => { if (!closed && !stopped) { trackingTimer = setTimeout(track, 100); trackingTimer.unref() } })
  }
  child.stdout!.pipe(stdout)
  child.stderr!.pipe(stderr)
  child.once('exit', code => { if (state !== 'unknown') state = 'exited'; exited.resolve({ exitCode: code }) })
  child.once('close', () => {
    closed = true
    clearTimeout(trackingTimer)
    void tracking.then(async () => {
      if (!tree || unverified) { unknown(new Error('Observed process ended without complete descendant identities')); return }
      const states = await Promise.all(tree.members.map(inspectProcessIdentity))
      if (states.includes('unknown')) { unverified = true; unknown(new Error('Observed descendant identity is unknown')); return }
      if (states.includes('matching')) { await handle.stop('surviving descendants'); return }
      settle()
    }).catch(error => unknown(error instanceof Error ? error : new Error(String(error))))
  })
  child.once('error', error => { unknown(error); if (!child.pid) { active.delete(id); physicallySettled.resolve() } })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  rootIdentity.value = await captureProcessIdentity(child.pid) ?? undefined
  if (!rootIdentity.value) unknown(new Error('Observed root birth identity could not be verified'))
  else { state = 'running'; tree = { root: rootIdentity.value, members: [rootIdentity.value], detached: true }; track() }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  return handle
}
