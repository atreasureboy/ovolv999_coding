import { afterEach, beforeAll, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from '../../src/core/processIdentity.js'
import { resolveExecutionPolicy } from '../../src/core/executionPolicy.js'
import { spawnManagedProcess, getManagedProcessHealth, type ManagedProcess } from '../../src/core/managedProcess.js'
import { spawnManagedChildProcess } from '../../src/core/managedChildProcess.js'
import { once } from 'node:events'

const fixture = resolve('tests/fixtures/process-ownership.mjs')
const directories: string[] = []
const children: ProcessIdentity[] = []
const processes: ManagedProcess[] = []

function directory(): string {
  const path = mkdtempSync(join(resolve('.artifacts'), 'ownership-'))
  directories.push(path)
  return path
}

function options(cwd: string) {
  return { cwd, env: process.env, policy: resolveExecutionPolicy(undefined, cwd) }
}

async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array))
  return Buffer.concat(chunks)
}

beforeAll(() => {
  if (process.platform === 'win32') {
    execFileSync(process.execPath, ['native/execution-host/build.mjs'], { windowsHide: true })
    const framework = join(process.env.WINDIR ?? 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319')
    execFileSync(join(framework, 'csc.exe'), ['/nologo', '/target:exe', '/platform:x64', '/out:' + resolve('native/execution-host/bin/breakaway-probe.exe'), '/reference:' + join(framework, 'System.Web.Extensions.dll'), resolve('native/execution-host/tests/BreakawayProbe.cs')], { windowsHide: true })
  }
})

async function until(predicate: () => boolean, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Ownership fixture deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

afterEach(async () => {
  for (const process of processes.splice(0)) await process.stop('test cleanup')
  for (const child of children.splice(0)) {
    if (await inspectProcessIdentity(child) === 'matching') {
      process.kill(child.pid, 'SIGKILL')
      await until(() => { try { process.kill(child.pid, 0); return false } catch { return true } })
    }
  }
  for (const directory of directories.splice(0)) {
    await until(() => {
      try { rmSync(directory, { recursive: true, force: true }); return true } catch { return false }
    })
  }
})

it.runIf(process.platform === 'win32')('contains a detached descendant born before a fast parent exit', async () => {
  const directory = mkdtempSync(join(resolve('.artifacts'), 'ownership-'))
  directories.push(directory)
  const record = join(directory, 'process.json')
  const processHandle = await spawnManagedProcess(process.execPath, [fixture, 'fast-parent', record], {
    cwd: directory, env: process.env, policy: resolveExecutionPolicy(undefined, directory),
  })
  processes.push(processHandle)
  processHandle.stdout.resume()
  processHandle.stderr.resume()
  expect(processHandle.accounting).toBe('contained')
  expect(processHandle.identity?.birthId).toMatch(/^\d+$/)
  await expect(processHandle.exited).resolves.toEqual({ exitCode: 0 })
  await until(() => existsSync(record + '.ready'))
  const childPid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
  const identity = await captureProcessIdentity(childPid)
  if (identity) children.push(identity)
  expect(identity).not.toBeNull()
  let settled = false
  void processHandle.physicallySettled.then(() => { settled = true })
  expect(settled).toBe(false)
  expect(getManagedProcessHealth().activeProcesses).toBeGreaterThan(0)
  await processHandle.stop('cancel escaped descendant')
  await processHandle.physicallySettled
  expect(() => process.kill(childPid, 0)).toThrow()
}, 20000)

it.runIf(process.platform === 'win32')('physically settles a failed worker launch without consuming capacity forever', async () => {
  const cwd = directory()
  const before = getManagedProcessHealth().activeProcesses
  const error = await spawnManagedProcess(join(cwd, 'missing.exe'), [], options(cwd)).catch(error => error as Error & { managedProcess: ManagedProcess }) as Error & { managedProcess: ManagedProcess }
  expect(error.message).toMatch(/CreateProcessW/)
  expect(error.managedProcess).toBeDefined()
  let settled = false
  void error.managedProcess.physicallySettled.then(() => { settled = true })
  await until(() => settled, 3000)
  expect(getManagedProcessHealth().activeProcesses).toBe(before)
}, 10000)

it.runIf(process.platform === 'win32')('preserves argument boundaries, Unicode cwd and reviewed environment without shell expansion', async () => {
  const cwd = directory()
  const args = ['a b', '"quoted"', 'trail\\', '', '中文', '$(echo injected)', '& exit 5']
  const policy = resolveExecutionPolicy({ envAllowlist: ['OWNERSHIP_VALUE'] }, cwd)
  const child = await spawnManagedProcess(process.execPath, [fixture, 'args', '', ...args], { cwd, policy, env: { ...process.env, OWNERSHIP_VALUE: '审查值', FORBIDDEN_SECRET: 'do-not-inherit' } })
  processes.push(child)
  const output = collect(child.stdout)
  child.stderr.resume()
  await child.physicallySettled
  expect(JSON.parse((await output).toString('utf8'))).toEqual({ args, cwd, value: '审查值' })
}, 10000)

it.runIf(process.platform === 'win32')('preserves raw stdout and stderr bytes without protocol messages', async () => {
  const cwd = directory()
  const child = await spawnManagedProcess(process.execPath, [fixture, 'bytes', ''], options(cwd))
  processes.push(child)
  const output = collect(child.stdout)
  const errors = collect(child.stderr)
  await child.physicallySettled
  expect(await output).toEqual(Buffer.from([0, 255, 10, 13, 128]))
  expect(await errors).toEqual(Buffer.from([254, 0, 7]))
}, 10000)

it.runIf(process.platform === 'win32')('forwards stdin with acknowledged backpressure and physically closes on EOF', async () => {
  const cwd = directory()
  const child = await spawnManagedProcess(process.execPath, [fixture, 'stdin', ''], options(cwd))
  processes.push(child)
  const output = collect(child.stdout)
  child.stderr.resume()
  const bytes = Buffer.alloc(196609, 171)
  expect(child.stdin!.write(bytes)).toBe(false)
  await new Promise<void>((resolve, reject) => { child.stdin!.end((error?: Error | null) => { if (error) reject(error); else resolve() }) })
  await child.physicallySettled
  expect(await output).toEqual(bytes)
}, 10000)

it.runIf(process.platform === 'win32')('refuses native breakaway instead of allowing a descendant outside its job', async () => {
  const cwd = directory()
  const record = join(cwd, 'breakaway.json')
  const child = await spawnManagedProcess(resolve('native/execution-host/bin/breakaway-probe.exe'), [process.execPath, fixture, record], options(cwd))
  processes.push(child)
  child.stdout.resume()
  child.stderr.resume()
  await child.physicallySettled
  const result = JSON.parse(readFileSync(record, 'utf8')) as { accepted: boolean; error: number; childPid: number }
  if (result.childPid) {
    const identity = await captureProcessIdentity(result.childPid)
    if (identity) children.push(identity)
  }
  expect(result.accepted).toBe(false)
  expect(result.error).toBe(5)
  expect(result.childPid).toBe(0)
}, 10000)

it.runIf(process.platform === 'win32')('cancels the job while descendants continue being created', async () => {
  const cwd = directory()
  const record = join(cwd, 'racing.json')
  const abort = new AbortController()
  const child = await spawnManagedProcess(process.execPath, [fixture, 'cancel-spawner', record], { ...options(cwd), signal: abort.signal })
  processes.push(child)
  child.stdout.resume()
  child.stderr.resume()
  await until(() => existsSync(record + '.children') && readFileSync(record + '.children', 'utf8').trim().split('\n').length >= 3)
  abort.abort()
  await child.physicallySettled
  const pids = [child.pid!, ...readFileSync(record + '.children', 'utf8').trim().split('\n').map(Number)]
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  expect(child.state).toBe('settled')
}, 10000)

it.runIf(process.platform === 'win32')('immediate pre-handshake cancellation proves no worker remains and restores capacity', async () => {
  const cwd = directory()
  const before = getManagedProcessHealth().activeProcesses
  const abort = new AbortController()
  const pending = spawnManagedProcess(process.execPath, [fixture, 'worker', join(cwd, 'early')], { ...options(cwd), signal: abort.signal })
  abort.abort()
  const result = await pending.then(child => child, (error: unknown) => (error as Error & { managedProcess: ManagedProcess }).managedProcess)
  expect(result).toBeDefined()
  result.stdout.resume()
  result.stderr.resume()
  let settled = false
  void result.physicallySettled.then(() => { settled = true })
  await until(() => settled, 1500)
  expect(result.state).toBe('settled')
  expect(getManagedProcessHealth().activeProcesses).toBe(before)
  expect(existsSync(join(cwd, 'early.ready'))).toBe(false)
}, 10000)

it.runIf(process.platform === 'win32')('job stop physically settles while public stdout remains unread', async () => {
  const cwd = directory()
  const child = await spawnManagedProcess(process.execPath, [fixture, 'output-burst', ''], options(cwd))
  processes.push(child)
  child.stderr.resume()
  await until(() => child.stdout.readableLength >= 16384)
  let settled = false
  const stopping = child.stop('stop with unread stdout').then(() => { settled = true })
  try {
    await until(() => settled, 1500)
    expect(child.state).toBe('settled')
    expect(() => process.kill(child.pid!, 0)).toThrow()
  } finally {
    child.stdout.resume()
    await stopping
  }
}, 10000)

it.runIf(process.platform === 'win32')('normal root completion preserves a bounded unread raw output burst', async () => {
  const cwd = directory()
  const child = await spawnManagedProcess(process.execPath, [fixture, 'output-finite', ''], options(cwd))
  processes.push(child)
  child.stderr.resume()
  let settled = false
  void child.physicallySettled.then(() => { settled = true })
  try {
    await until(() => settled, 1500)
    expect(child.failure).toBeUndefined()
    expect(await collect(child.stdout)).toEqual(Buffer.alloc(512 * 1024, 171))
  } finally { child.stdout.resume() }
}, 10000)

it.runIf(process.platform === 'win32')('unread output overflow fails explicitly, stays bounded and physically stops its job', async () => {
  const cwd = directory()
  const before = getManagedProcessHealth().activeProcesses
  const child = await spawnManagedProcess(process.execPath, [fixture, 'output-overflow', ''], options(cwd))
  processes.push(child)
  child.stderr.resume()
  try {
    expect((await child.failed).message).toMatch(/output buffer byte limit exceeded/)
    let settled = false
    void child.physicallySettled.then(() => { settled = true })
    await until(() => settled, 1500)
    expect(child.stdout.readableLength + child.stdout.writableLength + child.stderr.readableLength + child.stderr.writableLength).toBeLessThanOrEqual(1024 * 1024)
    expect(() => process.kill(child.pid!, 0)).toThrow()
    expect(getManagedProcessHealth().activeProcesses).toBe(before)
  } finally { child.stdout.resume() }
}, 10000)

it.runIf(process.platform === 'win32')('keeps cancellation bound to native ownership when a public PID identity is changed', async () => {
  const cwd = directory()
  const owned = await spawnManagedProcess(process.execPath, [fixture, 'worker', join(cwd, 'owned')], options(cwd))
  const unrelated = await spawnManagedProcess(process.execPath, [fixture, 'worker', join(cwd, 'unrelated')], options(cwd))
  processes.push(owned, unrelated)
  owned.stdout.resume()
  owned.stderr.resume()
  unrelated.stdout.resume()
  unrelated.stderr.resume()
  const publicIdentity = owned.identity!
  publicIdentity.pid = unrelated.pid!
  publicIdentity.birthId = unrelated.identity!.birthId
  await owned.stop('cancel original owner')
  expect(() => process.kill(owned.pid!, 0)).toThrow()
  expect(await inspectProcessIdentity(unrelated.identity!)).toBe('matching')
}, 10000)

it.runIf(process.platform === 'win32')('facade emits close only after fast-exit descendants have physically stopped', async () => {
  const cwd = directory()
  const record = join(cwd, 'facade.json')
  const child = spawnManagedChildProcess(process.execPath, [fixture, 'fast-parent', record], { ...options(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.resume()
  child.stderr!.resume()
  const events: string[] = []
  child.on('spawn', () => events.push('spawn'))
  child.on('exit', () => events.push('exit'))
  const closed = once(child, 'close')
  await closed
  events.push('close')
  const childPid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
  expect(() => process.kill(childPid, 0)).toThrow()
  expect(child.accounting).toBe('contained')
  expect(child.physicalState).toBe('settled')
  expect(events).toEqual(['spawn', 'exit', 'close'])
  await child.physicallySettled
}, 10000)

it.runIf(process.platform === 'win32')('facade preserves delayed-reader bytes while physical settlement does not wait for output delivery', async () => {
  const cwd = directory()
  const before = getManagedProcessHealth().activeProcesses
  const child = spawnManagedChildProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(256 * 1024, 171)); process.stderr.write(Buffer.alloc(128 * 1024, 93))'], { ...options(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  const errors: Error[] = []
  child.on('error', error => errors.push(error))
  let closed = false
  child.once('close', () => { closed = true })
  let settled = false
  void child.physicallySettled.then(() => { settled = true })
  try {
    await until(() => settled, 1500)
    const closedBeforeRead = closed
    expect(child.physicalState).toBe('settled')
    expect(getManagedProcessHealth().activeProcesses).toBe(before)
    expect(() => process.kill(child.pid!, 0)).toThrow()
    const [output, diagnostics] = await Promise.all([collect(child.stdout!), collect(child.stderr!)])
    expect(output.length).toBe(256 * 1024)
    expect(output.equals(Buffer.alloc(256 * 1024, 171))).toBe(true)
    expect(diagnostics.length).toBe(128 * 1024)
    expect(diagnostics.equals(Buffer.alloc(128 * 1024, 93))).toBe(true)
    await until(() => closed)
    expect(closedBeforeRead).toBe(false)
    expect(errors).toEqual([])
  } finally { child.stdout!.resume(); child.stderr!.resume(); await child.physicallySettled }
}, 10000)

it.runIf(process.platform === 'win32')('facade close callback sees every byte delivered to active readers', async () => {
  const cwd = directory()
  const child = spawnManagedChildProcess(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(256 * 1024, 171)); process.stderr.write(Buffer.alloc(128 * 1024, 93))'], { ...options(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  const output: Buffer[] = []
  const diagnostics: Buffer[] = []
  const errors: Error[] = []
  child.on('error', error => errors.push(error))
  child.stdout!.on('data', chunk => output.push(Buffer.from(chunk as Uint8Array)))
  child.stderr!.on('data', chunk => diagnostics.push(Buffer.from(chunk as Uint8Array)))
  const delivered = await new Promise<{ stdout: Buffer; stderr: Buffer }>(resolveClose => child.once('close', () => resolveClose({ stdout: Buffer.concat(output), stderr: Buffer.concat(diagnostics) })))
  expect(delivered.stdout.length).toBe(256 * 1024)
  expect(delivered.stdout.equals(Buffer.alloc(256 * 1024, 171))).toBe(true)
  expect(delivered.stderr.length).toBe(128 * 1024)
  expect(delivered.stderr.equals(Buffer.alloc(128 * 1024, 93))).toBe(true)
  expect(errors).toEqual([])
  expect(child.physicalState).toBe('settled')
}, 10000)

it.runIf(process.platform === 'win32')('facade reports a missing helper before close and creates no worker', async () => {
  const cwd = directory()
  const events: string[] = []
  const child = spawnManagedChildProcess(process.execPath, [fixture, 'worker', join(cwd, 'never')], { ...options(cwd), helperPath: join(cwd, 'missing.exe') })
  child.on('error', error => { expect(error.message).toMatch(/unavailable/); events.push('error') })
  await new Promise<void>(resolve => child.once('close', () => { events.push('close'); resolve() }))
  await child.physicallySettled
  expect(events).toEqual(['error', 'close'])
  expect(child.pid).toBeUndefined()
  expect(existsSync(join(cwd, 'never.ready'))).toBe(false)
}, 10000)

it.runIf(process.platform === 'win32')('facade buffers pre-start stdin and kill waits for physical child settlement', async () => {
  const cwd = directory()
  const child = spawnManagedChildProcess(process.execPath, [fixture, 'stdin', ''], options(cwd))
  const output = collect(child.stdout!)
  child.stderr!.resume()
  child.stdin!.end(Buffer.from('before startup 中文'))
  await once(child, 'close')
  expect(await output).toEqual(Buffer.from('before startup 中文'))
  const running = spawnManagedChildProcess(process.execPath, [fixture, 'worker', join(cwd, 'kill')], { ...options(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  running.stdout!.resume()
  running.stderr!.resume()
  await once(running, 'spawn')
  const closed = once(running, 'close')
  expect(running.kill('SIGTERM')).toBe(true)
  await closed
  expect(running.killed).toBe(true)
  expect(() => process.kill(running.pid!, 0)).toThrow()
  expect(running.physicalState).toBe('settled')
}, 10000)

it.runIf(process.platform === 'win32')('retains physical capacity until surviving descendants are confirmed stopped', async () => {
  const cwd = directory()
  const record = join(cwd, 'capacity.json')
  const policy = resolveExecutionPolicy({ limits: { processes: 1 } }, cwd)
  const child = await spawnManagedProcess(process.execPath, [fixture, 'worker', record], { ...options(cwd), policy })
  processes.push(child)
  child.stdout.resume()
  child.stderr.resume()
  await expect(spawnManagedProcess(process.execPath, [fixture, 'bytes', ''], { ...options(cwd), policy })).rejects.toThrow(/physical capacity/)
  await child.stop('release physical resource')
  const replacement = await spawnManagedProcess(process.execPath, [fixture, 'bytes', ''], { ...options(cwd), policy })
  processes.push(replacement)
  replacement.stdout.resume()
  replacement.stderr.resume()
  await replacement.physicallySettled
}, 10000)

it.runIf(process.platform === 'win32')('fails closed before launching a worker under an unsupported isolation policy', async () => {
  const cwd = directory()
  const policy = resolveExecutionPolicy({ mode: 'isolated-worker' }, cwd)
  await expect(spawnManagedProcess(process.execPath, [fixture, 'worker', join(cwd, 'isolated')], { ...options(cwd), policy })).rejects.toThrow(/isolation is unavailable/)
  expect(existsSync(join(cwd, 'isolated.ready'))).toBe(false)
}, 10000)

it.runIf(process.platform === 'win32')('normal facade root exit remains successful across repeated settlement races', async () => {
  const cwd = directory()
  for (let iteration = 0; iteration < 12; iteration++) {
    const child = spawnManagedChildProcess(process.execPath, [fixture, 'bytes', ''], { ...options(cwd), stdio: 'ignore' })
    const errors: Error[] = []
    child.on('error', error => errors.push(error))
    await new Promise<void>(resolve => child.once('close', resolve))
    expect(child.exitCode).toBe(0)
    expect(errors).toEqual([])
    expect(child.physicalState).toBe('settled')
  }
}, 10000)

it.runIf(process.platform === 'win32')('helper crash kills owned descendants but retains unknown physical state and does not emit close', async () => {
  const cwd = directory()
  const record = join(cwd, 'crash.json')
  const before = getManagedProcessHealth().activeProcesses
  const child = spawnManagedChildProcess(process.execPath, [fixture, 'cancel-spawner', record], { ...options(cwd), stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.resume()
  child.stderr!.resume()
  await once(child, 'spawn')
  await until(() => existsSync(record + '.children'))
  const pids = [child.pid!, ...readFileSync(record + '.children', 'utf8').trim().split('\n').map(Number)]
  let closed = false
  let physicallySettled = false
  child.once('close', () => { closed = true })
  void child.physicallySettled.then(() => { physicallySettled = true })
  const failure = once(child, 'error')
  process.kill(child.managedProcess!.controllerPid!, 'SIGKILL')
  await failure
  await until(() => pids.every(pid => { try { process.kill(pid, 0); return false } catch { return true } }))
  expect(closed).toBe(false)
  expect(physicallySettled).toBe(false)
  expect(child.physicalState).toBe('unknown')
  expect(child.physicalFailure?.message).toMatch(/without physical settlement proof/)
  expect(getManagedProcessHealth().activeProcesses).toBe(before + 1)
  await expect(child.managedProcess!.stop('cannot confirm after helper crash')).rejects.toThrow(/without physical settlement proof/)
}, 10000)
