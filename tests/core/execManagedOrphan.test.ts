import { expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { createProcessScope, execManaged } from '../../src/core/executionBackend.js'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from '../../src/core/processIdentity.js'
import * as processTree from '../../src/core/processTree.js'
import * as nativeFacade from '../../src/core/managedChildProcess.js'

const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))

it('retains physical ownership when the root closes during cancellation discovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-orphan-'))
  const controller = new AbortController()
  const scope = createProcessScope()
  let leaf: ProcessIdentity | null = null
  const operation = scope.run(() => execManaged(process.execPath, [resolve('tests/fixtures/task-orphan.mjs'), 'root', directory], { signal: controller.signal, timeoutMs: 15_000 }))
  const observed = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error & { unfinishedResources?: string[] } }))
  try {
    const readyDeadline = Date.now() + 8000
    while (!existsSync(join(directory, 'leaf.pid')) && Date.now() < readyDeadline) await pause()
    expect(existsSync(join(directory, 'leaf.pid'))).toBe(true)
    leaf = await captureProcessIdentity(Number(readFileSync(join(directory, 'leaf.pid'), 'utf8')))
    expect(leaf).not.toBeNull()
    writeFileSync(join(directory, 'exit-root'), '')
    controller.abort(new Error('requested managed cancellation'))
    const result = await observed
    const descendantState = await inspectProcessIdentity(leaf!)
    if (descendantState === 'matching') {
      expect(result.error?.unfinishedResources?.length).toBeGreaterThan(0)
      expect(scope.pending.size).toBeGreaterThan(0)
    } else {
      expect(descendantState).toBe('dead')
      expect(scope.pending.size).toBe(0)
    }
  } finally {
    writeFileSync(join(directory, 'exit-root'), '')
    writeFileSync(join(directory, 'stop-leaf'), '')
    const stopDeadline = Date.now() + 8000
    while (leaf && await inspectProcessIdentity(leaf) === 'matching' && Date.now() < stopDeadline) await pause()
    await observed
    rmSync(directory, { recursive: true, force: true })
  }
}, 25_000)

it('settles owned descendants before releasing a normally closed command', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'managed-observed-orphan-'))
  const scope = createProcessScope()
  let leaf: ProcessIdentity | null = null
  let tracked = false
  const nativeLaunch = vi.spyOn(nativeFacade, 'spawnManagedChildProcess')
  const originalCapture = processTree.captureOwnedProcessTreeFromPid
  const snapshot = vi.spyOn(processTree, 'captureOwnedProcessTreeFromPid').mockImplementation(async (...args) => {
    const tree = await originalCapture(...args)
    if (leaf && tree?.members.some(member => member.pid === leaf!.pid && member.birthId === leaf!.birthId)) tracked = true
    return tree
  })
  const operation = scope.run(() => execManaged(process.execPath, [resolve('tests/fixtures/task-orphan.mjs'), 'root', directory], { timeoutMs: 20_000 }))
  const observed = operation.then(value => ({ value, error: undefined }), error => ({ value: undefined, error: error as Error & { unfinishedResources?: string[] } }))
  try {
    const readyDeadline = Date.now() + 8000
    while (!existsSync(join(directory, 'leaf.pid')) && Date.now() < readyDeadline) await pause()
    expect(existsSync(join(directory, 'leaf.pid'))).toBe(true)
    leaf = await captureProcessIdentity(Number(readFileSync(join(directory, 'leaf.pid'), 'utf8')))
    expect(leaf).not.toBeNull()
    if (process.platform !== 'win32') {
      const snapshotDeadline = Date.now() + 5000
      while (!tracked && Date.now() < snapshotDeadline) await pause()
    }
    writeFileSync(join(directory, 'exit-root'), '')
    const result = await observed
    const descendantState = await inspectProcessIdentity(leaf!)
    expect({ completed: result.error === undefined, pending: scope.pending.size, descendantState }).not.toEqual({ completed: true, pending: 0, descendantState: 'matching' })
    if (process.platform === 'win32') {
      const child = nativeLaunch.mock.results[0]?.value as ReturnType<typeof nativeFacade.spawnManagedChildProcess>
      expect(child.accounting).toBe('contained')
      expect(child.physicalState).toBe('settled')
      expect(snapshot).not.toHaveBeenCalled()
      expect(descendantState).toBe('dead')
      expect(result.error).toBeUndefined()
      expect(scope.pending.size).toBe(0)
    } else if (descendantState === 'matching') {
      expect(tracked).toBe(true)
      expect(result.error?.unfinishedResources?.length).toBeGreaterThan(0)
      expect(scope.pending.size).toBeGreaterThan(0)
    } else {
      expect(tracked).toBe(true)
      expect(descendantState).toBe('dead')
      expect(result.error?.message).toContain('owned descendants')
      expect(scope.pending.size).toBe(0)
    }
  } finally {
    writeFileSync(join(directory, 'exit-root'), '')
    writeFileSync(join(directory, 'stop-leaf'), '')
    const stopDeadline = Date.now() + 8000
    while (leaf && await inspectProcessIdentity(leaf) === 'matching' && Date.now() < stopDeadline) await pause()
    await observed
    snapshot.mockRestore()
    nativeLaunch.mockRestore()
    rmSync(directory, { recursive: true, force: true })
  }
}, 30_000)

it.each([0, 100, 800])('preserves successful ordinary command exit after %d ms', async duration => {
  const scope = createProcessScope()
  const result = await scope.run(() => execManaged(process.execPath, ['-e', `setTimeout(() => process.stdout.write('completed'), ${duration})`]))
  expect(result).toEqual({ stdout: 'completed', stderr: '' })
  expect(scope.pending.size).toBe(0)
}, 15_000)
