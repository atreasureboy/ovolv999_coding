import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createProcessScope, execManaged, getExecutionHealth, isManagedChild, spawnManaged } from '../../src/core/executionBackend.js'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from '../../src/core/processIdentity.js'
import { runFileVerificationCommand, runVerificationCommand } from '../../src/core/verification.js'
import { BackgroundTaskManager } from '../../src/core/backgroundTaskManager.js'
import { McpStdioClient } from '../../src/core/mcpClient.js'
import { once } from 'node:events'
import * as managedProcess from '../../src/core/managedProcess.js'

const fixture = resolve('tests/fixtures/process-ownership.mjs')
const directories: string[] = []
const children: ProcessIdentity[] = []

beforeAll(() => {
  if (process.platform === 'win32') execFileSync(process.execPath, ['native/execution-host/build.mjs'], { windowsHide: true })
})

async function until(predicate: () => boolean, milliseconds = 5000): Promise<void> {
  const deadline = Date.now() + milliseconds
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Production ownership fixture deadline exceeded')
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (await inspectProcessIdentity(child) === 'matching') process.kill(child.pid, 'SIGKILL')
  }
  for (const directory of directories.splice(0)) await until(() => { try { rmSync(directory, { recursive: true, force: true }); return true } catch { return false } })
})

it.runIf(process.platform === 'win32')('execManaged closes only after a fast parent detached descendant is dead', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const record = join(cwd, 'process.json')
  await execManaged(process.execPath, [fixture, 'fast-parent', record], { cwd, timeoutMs: 10000 })
  const childPid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
  const identity = await captureProcessIdentity(childPid)
  if (identity) children.push(identity)
  expect(() => process.kill(childPid, 0)).toThrow()
}, 20000)

it.runIf(process.platform === 'win32')('normalizes shell execution into a contained command for verification and execManaged', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const output = await execManaged('echo reviewed-shell', [], { cwd, shell: true })
  expect(output.stdout.trim()).toBe('reviewed-shell')
  const result = await runVerificationCommand('echo reviewed-verification', cwd)
  expect(result.passed).toBe(true)
  expect(result.output).toBe('reviewed-verification')
}, 10000)

it.runIf(process.platform === 'win32')('file verification waits for real fast-exit descendants before accepting exit zero', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const record = join(cwd, 'verify.json')
  const result = await runFileVerificationCommand(process.execPath, [fixture, 'fast-parent', record], cwd)
  expect(result.passed).toBe(true)
  expect(result.unfinishedResources).toBeUndefined()
  const pid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
  expect(() => process.kill(pid, 0)).toThrow()
}, 10000)

it.runIf(process.platform === 'win32')('background completion reports contained only after its native physical scope is clear', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const record = join(cwd, 'background.json')
  const manager = new BackgroundTaskManager({ sigkillGraceMs: 0 })
  const scope = createProcessScope()
  try {
    const id = await scope.run(() => Promise.resolve(manager.createTask(`"${process.execPath}" "${fixture}" fast-parent "${record}"`, { cwd })))
    const result = await manager.waitForTask(id, 10000)
    expect(result?.status).toBe('completed')
    expect(result?.processAccounting).toBe('contained')
    expect(scope.pending.size).toBe(0)
    const pid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
    expect(() => process.kill(pid, 0)).toThrow()
  } finally { await manager.dispose() }
}, 15000)

it.runIf(process.platform === 'win32')('MCP close uses native ownership and waits for its detached descendant', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const record = join(cwd, 'mcp.json')
  const server = join(cwd, 'mcp.mjs')
  writeFileSync(server, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';const child=spawn(process.execPath,${JSON.stringify([fixture, 'worker', record])},{detached:true,stdio:'ignore'});child.unref();writeFileSync(${JSON.stringify(record)},JSON.stringify({childPid:child.pid}));createInterface({input:process.stdin}).on('line',line=>{const value=JSON.parse(line);if(value.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:value.id,result:value.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}}}:{tools:[]}})+'\\n')});`)
  const scope = createProcessScope()
  const client = new McpStdioClient({ name: 'ownership', type: 'stdio', command: [process.execPath, server], cwd })
  await scope.run(() => client.connect())
  const pid = (JSON.parse(readFileSync(record, 'utf8')) as { childPid: number }).childPid
  expect(() => process.kill(pid, 0)).not.toThrow()
  await client.close()
  expect(() => process.kill(pid, 0)).toThrow()
  expect(scope.pending.size).toBe(0)
}, 10000)

it.runIf(process.platform === 'win32')('IPC coordinators explicitly remain observed-only while non-IPC workers are native', async () => {
  const child = spawnManaged(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  child.stdout!.resume()
  child.stderr!.resume()
  expect(isManagedChild(child)).toBe(false)
  expect((child as typeof child & { accounting: string }).accounting).toBe('observed-only')
  await once(child, 'close')
  expect(getExecutionHealth().activeProcesses).toBe(0)
}, 10000)

it.runIf(process.platform === 'win32')('execManaged releases every physical scope resource after a proved failed native launch', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const scope = createProcessScope()
  await expect(scope.run(() => execManaged(join(cwd, 'missing.exe'), [], { cwd, timeoutMs: 5000 }))).rejects.toThrow(/CreateProcessW/)
  await until(() => scope.pending.size === 0, 3000)
  expect(getExecutionHealth().activeProcesses).toBe(0)
}, 10000)

it.runIf(process.platform === 'win32')('execManaged cancellation before native startup is logically bounded while physical ownership stays pending', async () => {
  let rejectStartup!: (error: Error) => void
  const startup = new Promise<managedProcess.ManagedProcess>((_resolve, reject) => { rejectStartup = reject })
  const launch = vi.spyOn(managedProcess, 'spawnManagedProcess').mockReturnValue(startup)
  const scope = createProcessScope()
  const controller = new AbortController()
  const outcome = scope.run(() => execManaged(process.execPath, [], { signal: controller.signal, timeoutMs: 10000 })).then(() => undefined, (error: unknown) => error as Error & { unfinishedResources?: string[] })
  let deadline: NodeJS.Timeout | undefined
  try {
    await until(() => launch.mock.calls.length === 1)
    controller.abort(new Error('cancel before native startup'))
    const result = await Promise.race([outcome, new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Logical cancellation remained blocked on physical startup')), 3500) })])
    expect(result?.message).toBe('cancel before native startup')
    expect(result?.unfinishedResources).toEqual(['process unknown'])
    expect(scope.pending.size).toBe(2)
    rejectStartup(new Error('proved pre-launch failure'))
    await until(() => scope.pending.size === 0)
  } finally {
    clearTimeout(deadline)
    rejectStartup(new Error('proved pre-launch failure'))
    launch.mockRestore()
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}, 10000)

it.runIf(process.platform === 'win32')('production physical scope and capacity remain pending after a native helper crash', async () => {
  const cwd = mkdtempSync(join(resolve('.artifacts'), 'ownership-wiring-'))
  directories.push(cwd)
  const record = join(cwd, 'unknown')
  const scope = createProcessScope()
  const before = getExecutionHealth().activeProcesses
  const child = await scope.run(() => Promise.resolve(spawnManaged(process.execPath, [fixture, 'worker', record], { cwd, stdio: ['ignore', 'pipe', 'pipe'] })))
  child.stdout!.resume()
  child.stderr!.resume()
  await once(child, 'spawn')
  await until(() => existsSync(record + '.ready'))
  expect(isManagedChild(child)).toBe(true)
  if (!isManagedChild(child)) throw new Error('Production path did not select native ownership')
  let closed = false
  child.once('close', () => { closed = true })
  const failure = once(child, 'error')
  process.kill(child.managedProcess!.controllerPid!, 'SIGKILL')
  await failure
  await until(() => { try { process.kill(child.pid!, 0); return false } catch { return true } })
  expect(child.physicalState).toBe('unknown')
  expect(closed).toBe(false)
  expect(scope.pending.size).toBe(1)
  expect(getExecutionHealth().activeProcesses).toBe(before + 1)
  expect(() => spawnManaged(process.execPath, [], { profile: { mode: 'trusted-local', maxProcesses: 1 } })).toThrow(/capacity/)
}, 10000)
