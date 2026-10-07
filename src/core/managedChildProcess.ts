import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import type { ChildProcess, SpawnOptions, IOType } from 'node:child_process'
import { spawnManagedProcess, type ManagedProcess } from './managedProcess.js'
import type { ExecutionPolicy } from './executionPolicy.js'

export type ManagedChildProcess = ChildProcess & {
  readonly managedProcess: ManagedProcess | undefined
  readonly physicallySettled: Promise<void>
  readonly accounting: ManagedProcess['accounting']
  readonly physicalState: ManagedProcess['state']
  readonly physicalFailure: Error | undefined
}

export function spawnManagedChildProcess(executable: string, args: readonly string[], options: SpawnOptions & { policy: ExecutionPolicy; helperPath?: string }): ManagedChildProcess {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let handle: ManagedProcess | undefined
  let failure: Error | undefined
  let state: ManagedProcess['state'] = 'starting'
  let exitCode: number | null = null
  let closed = false
  let physicalClosed = false
  let exitEmitted = false
  let stopRequested = false
  let killed = false
  let referenced = true
  let settle!: () => void
  const physicallySettled = new Promise<void>(resolve => { settle = resolve })
  let inputCallback: ((error?: Error | null) => void) | undefined
  const stdin = new Writable({
    write(chunk: Buffer | string, encoding, callback) {
      if (handle?.stdin) { handle.stdin.write(chunk, encoding, callback); return }
      if (failure || closed) { callback(failure ?? new Error('Managed child input closed')); return }
      inputCallback = () => { if (handle?.stdin) handle.stdin.write(chunk, encoding, callback); else callback(failure ?? new Error('Managed child did not start')) }
    },
    final(callback) {
      if (handle?.stdin) { handle.stdin.end(callback); return }
      if (failure || closed) { callback(); return }
      inputCallback = () => { if (handle?.stdin) handle.stdin.end(callback); else callback(failure ?? new Error('Managed child did not start')) }
    },
  })
  stdin.on('error', error => emitter.emit('error', error))
  const io = options.stdio ?? 'pipe'
  const descriptors = Array.isArray(io) ? io : [io, io, io]
  const normalized = descriptors.slice(0, 3).map((entry, index): IOType => {
    if (entry === undefined || entry === null) return 'pipe'
    if (entry === 'pipe' || entry === 'ignore' || entry === 'inherit') return entry
    if (entry === index) return 'inherit'
    throw new Error('Managed child stdio descriptor is unsupported; execution refused')
  })
  if (descriptors.length > 3 || options.shell || options.uid !== undefined || options.gid !== undefined || options.serialization || options.argv0 || options.cwd instanceof URL) throw new Error('Managed child spawn option is unsupported; execution refused')
  const child = Object.assign(emitter, {
    stdin: normalized[0] === 'pipe' ? stdin : null,
    stdout: normalized[1] === 'pipe' ? stdout : null,
    stderr: normalized[2] === 'pipe' ? stderr : null,
    stdio: [normalized[0] === 'pipe' ? stdin : null, normalized[1] === 'pipe' ? stdout : null, normalized[2] === 'pipe' ? stderr : null],
    spawnfile: executable,
    spawnargs: [executable, ...args],
    connected: false,
    signalCode: null,
    physicallySettled,
    ref() { referenced = true; handle?.ref(); return child },
    unref() { referenced = false; handle?.unref(); return child },
    disconnect() { emitter.emit('error', new Error('Managed child has no IPC channel')) },
    kill() {
      if (physicalClosed) return false
      stopRequested = true
      killed = true
      if (handle) void handle.stop('child kill requested').catch(error => report(error instanceof Error ? error : new Error(String(error))))
      return true
    },
  }) as unknown as ManagedChildProcess
  Object.defineProperties(child, {
    pid: { get: () => handle?.pid },
    killed: { get: () => killed },
    exitCode: { get: () => exitCode },
    managedProcess: { get: () => handle },
    accounting: { get: () => handle?.accounting ?? 'observed-only' },
    physicalState: { get: () => handle?.state ?? state },
    physicalFailure: { get: () => handle?.failure ?? failure },
  })
  const report = (error: Error): void => {
    if (failure) return
    failure = error
    if (!physicalClosed) state = 'unknown'
    emitter.emit('error', error)
  }
  const close = (): void => {
    if (closed || !physicalClosed || !stdout.writableFinished || !stderr.writableFinished) return
    closed = true
    emitter.emit('close', exitCode, null)
  }
  const completePhysical = (): void => {
    if (physicalClosed) return
    physicalClosed = true
    state = 'settled'
    settle()
    close()
  }
  stdout.once('finish', close)
  stderr.once('finish', close)
  const wire = (process: ManagedProcess): void => {
    handle = process
    state = process.state
    if (!referenced) process.unref()
    void process.failed.then(report)
    process.stdout.pipe(stdout)
    process.stderr.pipe(stderr)
    if (normalized[1] === 'ignore') stdout.resume()
    else if (normalized[1] === 'inherit') stdout.pipe(globalThis.process.stdout, { end: false })
    if (normalized[2] === 'ignore') stderr.resume()
    else if (normalized[2] === 'inherit') stderr.pipe(globalThis.process.stderr, { end: false })
    if (normalized[0] === 'ignore') process.stdin?.end()
    else if (normalized[0] === 'inherit' && process.stdin) globalThis.process.stdin.pipe(process.stdin)
    const callback = inputCallback
    inputCallback = undefined
    callback?.()
    emitter.emit('spawn')
    if (stopRequested) void process.stop('child kill requested before start').catch(error => report(error instanceof Error ? error : new Error(String(error))))
    void process.exited.then(({ exitCode: code }) => {
      exitCode = code
      exitEmitted = true
      emitter.emit('exit', code, null)
      void process.stop('root exited; settle owned descendants').catch(error => report(error instanceof Error ? error : new Error(String(error))))
    })
    void process.physicallySettled.then(() => {
      if (process.failure) report(process.failure)
      if (!exitEmitted && process.pid !== undefined) { exitEmitted = true; emitter.emit('exit', exitCode, null) }
      completePhysical()
    })
  }
  queueMicrotask(() => {
    void spawnManagedProcess(executable, args, {
      cwd: typeof options.cwd === 'string' ? options.cwd : process.cwd(),
      env: options.env ?? process.env,
      policy: options.policy,
      signal: options.signal,
      helperPath: options.helperPath,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
    }).then(wire, (error: unknown) => {
      const problem = error instanceof Error ? error : new Error(String(error))
      const owned = (problem as Error & { managedProcess?: ManagedProcess }).managedProcess
      report(problem)
      if (owned) {
        handle = owned
        owned.stdout.resume()
        owned.stderr.resume()
        void owned.physicallySettled.then(() => { stdout.end(); stderr.end(); completePhysical() })
      } else { stdout.end(); stderr.end(); completePhysical() }
      inputCallback?.(problem)
      inputCallback = undefined
    })
  })
  return child
}
