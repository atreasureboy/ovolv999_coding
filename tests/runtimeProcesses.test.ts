import { afterEach, expect, it } from 'vitest'
import { fork, type ChildProcess } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { ModuleKind, transpileModule } from 'typescript'
import { RunStore } from '../src/core/runStore.js'
import { readWorkspaceLease, reconcileWorkspace } from '../src/core/workspaceLease.js'
import { reconcileOperation } from '../src/core/operationRecovery.js'

const dirs: string[] = []
const children: ChildProcess[] = []
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'ovo-runtime-process-')); dirs.push(root)
  mkdirSync(join(root, 'runtime'))
  writeFileSync(join(root, 'runtime/package.json'), '{"type":"module"}')
  for (const name of ['runContext', 'runStore', 'workspaceLease', 'runtimeState', 'persistenceLock', 'processIdentity', 'processTree', 'fileState', 'executionBackend', 'executionPolicy', 'managedProcess', 'managedChildProcess', 'outcome']) {
    writeFileSync(join(root, 'runtime', name + '.js'), transpileModule(readFileSync(new URL(`../src/core/${name}.ts`, import.meta.url), 'utf8'), { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
  }
  return root
}
function worker(root: string, mode = 'hold') {
  const child = fork(fileURLToPath(new URL('./fixtures/runtimeOwner.mjs', import.meta.url)), [join(root, 'runtime'), root, mode], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  const messages: Array<string | { held?: boolean; store?: string; error?: string }> = []
  let stderr = ''
  let closed = false
  child.on('message', message => messages.push(message as typeof messages[number]))
  child.stderr?.on('data', chunk => { stderr += String(chunk) })
  child.on('error', error => { stderr += error.stack ?? error.message })
  child.on('close', () => { closed = true })
  return { child, messages, get closed() { return closed }, diagnostics: () => `${mode}: pid=${child.pid} exit=${child.exitCode} signal=${child.signalCode}\n${stderr}\n${JSON.stringify(messages)}` }
}
async function until(predicate: () => boolean, ...workers: ReturnType<typeof worker>[]): Promise<void> {
  const deadline = Date.now() + 15000
  while (!predicate()) {
    const details = workers.map(worker => worker.diagnostics()).join('\n')
    if (workers.some(worker => worker.closed)) throw new Error(`Runtime process exited before its barrier\n${details}`)
    if (Date.now() > deadline) throw new Error(`Runtime process barrier timed out\n${details}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL') })
}
afterEach(async () => { await Promise.all(children.splice(0).map(kill)); for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('keeps two independent process writers from overlapping', async () => {
  const root = directory()
  const first = worker(root); const second = worker(root, 'finish')
  await until(() => first.messages.includes('ready') && second.messages.includes('ready'), first, second)
  first.child.send('go')
  await until(() => first.messages.some(message => typeof message === 'object' && message.held), first)
  second.child.send('go')
  await new Promise(resolve => setTimeout(resolve, 500))
  expect(second.messages).toEqual(['ready'])
  first.child.send('finish')
  await until(() => second.messages.includes('released'), second)
  expect(readFileSync(join(root, 'effects'), 'utf8')).toBe('effect\neffect\n')
}, 20000)

it('blocks restart after kill between effect and receipt and never repeats the action', async () => {
  const root = directory()
  const first = worker(root)
  await until(() => first.messages.includes('ready'), first); first.child.send('go')
  await until(() => first.messages.some(message => typeof message === 'object' && message.held), first)
  const held = first.messages.find(message => typeof message === 'object' && message.held) as { store: string }
  await kill(first.child)
  expect(RunStore.inspect(held.store).status).toBe('needs_recovery')
  const restarted = worker(root, 'finish')
  await until(() => restarted.messages.includes('ready'), restarted); restarted.child.send('go')
  await until(() => restarted.messages.some(message => typeof message === 'object' && message.error), restarted)
  expect(restarted.messages).toContainEqual({ error: expect.stringMatching(/needs recovery/) })
  expect(readFileSync(join(root, 'effects'), 'utf8')).toBe('effect\n')
  const stateRoot = join(root, 'state')
  const record = readWorkspaceLease(root, stateRoot)!
  await expect(reconcileWorkspace(root, { stateRoot, expectedEpoch: record.epoch, decision: 'cancel', physicalStopConfirmed: true, artifactVersion: 'confirmed-test-artifact' })).rejects.toThrow(/operation reconciliation/)
  const run = RunStore.inspect(held.store)
  const operationId = Object.keys(run.operations)[0]
  await reconcileOperation(held.store, operationId, { expectedEpoch: run.epoch, expectedRevision: run.revision, decision: 'cancel', physicalStopConfirmed: true })
  await reconcileWorkspace(root, { stateRoot, expectedEpoch: record.epoch, decision: 'cancel', physicalStopConfirmed: true, artifactVersion: 'confirmed-test-artifact' })
  expect(readWorkspaceLease(root, stateRoot)?.state).toBe('released')
  expect(readFileSync(join(root, 'effects'), 'utf8')).toBe('effect\n')
}, 20000)
