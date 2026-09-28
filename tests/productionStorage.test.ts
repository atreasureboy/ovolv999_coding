import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionDir, loadSession, saveSession, releaseSessionOwnership, resolveSessionPath, findLatestSession } from '../src/core/sessionManager.js'
import { acquirePersistenceLease, withPersistenceLock } from '../src/core/persistenceLock.js'
import { captureProcessIdentity, inspectProcessIdentity } from '../src/core/processIdentity.js'
import type { OpenAIMessage } from '../src/core/types.js'
import { transpileModule, ModuleKind } from 'typescript'

const dirs: string[] = []
const children: ChildProcess[] = []
const fixture = fileURLToPath(new URL('./fixtures/productionStorageWorker.mjs', import.meta.url))
function directory(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-production-storage-'))
  dirs.push(dir)
  return dir
}
function worker(mode: string, dir: string, value = '') {
  const runtime = join(dir, 'runtime')
  if (!existsSync(runtime)) {
    mkdirSync(runtime)
    writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
    for (const name of ['sessionManager', 'persistenceLock', 'processIdentity']) {
      const sourcePath = new URL(`../src/core/${name}.ts`, import.meta.url)
      if (!existsSync(sourcePath)) continue
      writeFileSync(join(runtime, `${name}.js`), transpileModule(readFileSync(sourcePath, 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
    }
  }
  const child = fork(fixture, [mode, dir, value, runtime], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  const messages: unknown[] = []
  let stderr = ''
  child.on('message', message => messages.push(message))
  child.stderr?.on('data', data => { stderr += String(data) })
  return { child, messages, diagnostics: () => stderr }
}
async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Process barrier timed out')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL') })
}
afterEach(async () => {
  await Promise.all(children.splice(0).map(kill))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('creates 100 unique sessions from two real processes at the same timestamp', async () => {
  const dir = directory()
  const workers = [worker('create', dir, '50'), worker('create', dir, '50')]
  await until(() => workers.every(w => w.messages.includes('ready')))
  workers.forEach(w => w.child.send('go'))
  await until(() => workers.every(w => w.messages.some(Array.isArray)))
  const paths = workers.flatMap(w => w.messages.find(Array.isArray) as string[])
  expect(paths).toHaveLength(100)
  expect(new Set(paths).size).toBe(100)
})

it('round trips multimodal content without converting or dropping image parts', () => {
  const dir = createSessionDir(directory())
  const messages: OpenAIMessage[] = [{ role: 'user', content: [{ type: 'text', text: 'inspect this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] }]
  saveSession(dir, messages)
  expect(loadSession(dir)).toEqual(messages)
})

it('rejects a competing session writer and preserves the first writer history', async () => {
  const dir = createSessionDir(directory())
  const first = worker('save', dir, 'first')
  await until(() => first.messages.includes('ready'))
  first.child.send('go')
  await until(() => first.messages.includes('saved'))
  const second = worker('save', dir, 'second')
  await until(() => second.messages.includes('ready'))
  second.child.send('go')
  await until(() => second.messages.length > 1)
  expect(second.messages).toContainEqual({ error: expect.stringMatching(/owner|busy|conflict/i) })
  expect(loadSession(dir)[0].content).toBe('first')
})

it('recovers after killing the real recovery owner without deleting diagnostic legacy locks', async () => {
  const dir = directory()
  const dead = worker('legacyOwner', dir)
  await until(() => dead.messages.includes('ready'))
  dead.child.send('go')
  await until(() => dead.messages.includes('held'))
  await kill(dead.child)
  if (!existsSync(join(dir, 'state.lock'))) writeFileSync(join(dir, 'state.lock'), JSON.stringify({ pid: dead.child.pid }))
  const recovering = worker('legacyRecovery', dir)
  await until(() => recovering.messages.includes('ready'))
  recovering.child.send('go')
  await until(() => recovering.messages.includes('recovering') || recovering.messages.includes('acquired'))
  await kill(recovering.child)
  expect(withPersistenceLock(join(dir, 'state'), () => 'persisted', 50)).toBe('persisted')
})

it('preserves a malformed history file when loading and saving fails', () => {
  const dir = createSessionDir(directory())
  const path = join(dir, 'history.json')
  writeFileSync(path, '{broken')
  expect(() => loadSession(dir)).toThrow(/malformed/)
  expect(() => saveSession(dir, [{ role: 'user', content: 'overwrite' }])).toThrow(/malformed/)
  expect(readFileSync(path, 'utf8')).toBe('{broken')
})

it.each(['owner-published', 'ticket-opened', 'ticket-synced', 'ticket-published', 'before-commit', 'after-commit', 'release-started'])('recovers after real SIGKILL at %s', async phase => {
  const dir = directory()
  const holder = worker('crashPhase', dir, phase)
  await until(() => holder.messages.includes('ready'))
  holder.child.send('go')
  await until(() => holder.messages.includes(phase))
  await kill(holder.child)
  const lease = await acquirePersistenceLease(join(dir, 'state'))
  expect(existsSync(join(dir, 'committed'))).toBe(['after-commit', 'release-started'].includes(phase))
  lease.assertOwned()
  lease.release()
}, 20000)

it('serializes real independent writers without overwriting concurrent updates', async () => {
  const dir = directory()
  const workers = [worker('increment', dir, '5'), worker('increment', dir, '5')]
  await until(() => workers.every(w => w.messages.includes('ready')))
  workers.forEach(w => w.child.send('go'))
  await until(() => workers.every(w => w.messages.includes('done')))
  expect(readFileSync(join(dir, 'counter'), 'utf8')).toBe('10')
}, 20000)

it('rejects a second real resume owner before either process saves', async () => {
  const dir = createSessionDir(directory())
  const first = worker('resume', dir)
  await until(() => first.messages.includes('ready'))
  first.child.send('go')
  await until(() => first.messages.includes('claimed'))
  const second = worker('resume', dir)
  await until(() => second.messages.includes('ready'))
  second.child.send('go')
  await until(() => second.messages.length > 1)
  expect(second.messages).toContainEqual({ error: expect.stringMatching(/busy/) })
})

it('rejects a stale loaded revision after another process has saved and exited', async () => {
  const dir = createSessionDir(directory())
  const stale = worker('staleWriter', dir)
  await until(() => stale.messages.includes('ready'))
  stale.child.send('go')
  await until(() => stale.messages.includes('loaded'))
  const writer = worker('save', dir, 'current')
  await until(() => writer.messages.includes('ready'))
  writer.child.send('go')
  await until(() => writer.messages.includes('saved'))
  await kill(writer.child)
  stale.child.send('go')
  await until(() => stale.messages.some(m => !!m && typeof m === 'object' && 'error' in m))
  expect(stale.messages).toContainEqual({ error: expect.stringMatching(/revision conflict/) })
  expect(loadSession(dir)[0].content).toBe('current')
})

it('keeps the event loop responsive while async coordination waits and sync callers fail immediately', async () => {
  const dir = directory()
  const path = join(dir, 'state')
  await captureProcessIdentity()
  const holder = worker('lease', dir)
  await until(() => holder.messages.includes('ready'))
  holder.child.send('go')
  await until(() => holder.messages.includes('held'))
  const before = performance.now()
  expect(() => withPersistenceLock(path, () => null)).toThrow(/busy/)
  expect(performance.now() - before).toBeLessThan(150)
  const controller = new AbortController()
  let ticks = 0
  const interval = setInterval(() => { ticks++ }, 5)
  const cancel = setTimeout(() => controller.abort(new Error('cancelled wait')), 100)
  try { await expect(acquirePersistenceLease(path, { signal: controller.signal })).rejects.toThrow(/cancelled wait/) } finally { clearInterval(interval); clearTimeout(cancel) }
  expect(ticks).toBeGreaterThan(5)
})

it('recognizes a live PID with a different birth identity without treating it as the owner', async () => {
  const identity = await captureProcessIdentity()
  expect(identity).not.toBeNull()
  expect(await inspectProcessIdentity(identity!)).toBe('matching')
  expect(await inspectProcessIdentity({ ...identity!, birthId: 'different-process-birth' })).toBe('mismatch')
})

it('keeps legacy timestamp-only lookup and upgrades ownership fields on the first save', () => {
  const cwd = directory()
  const dir = join(cwd, 'sessions', 'session_2020-01-01_000000')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'history.json'), JSON.stringify({ version: 1, schema: 'ovogo.session.v1', updatedAt: '2020-01-01T00:00:00.000Z', messages: [{ role: 'user', content: 'legacy' }] }))
  expect(resolveSessionPath(cwd, 'session_2020')).toBe(dir)
  expect(findLatestSession(cwd)).toBe(dir)
  const messages = loadSession(dir)
  saveSession(dir, messages)
  const saved = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))
  expect(saved).toMatchObject({ version: 2, revision: 1, messages, owner: { pid: process.pid } })
  expect(saved.sessionId).toMatch(/^legacy_/)
  releaseSessionOwnership(dir)
})
