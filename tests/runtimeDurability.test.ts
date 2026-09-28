import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RunStore } from '../src/core/runStore.js'
import { acquireWorkspaceLease, readWorkspaceLease } from '../src/core/workspaceLease.js'

const dirs: string[] = []
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'ovo-runtime-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

it('persists intent before the effect and reports the missing receipt as unknown', () => {
  const root = directory()
  const store = new RunStore(root, { runId: 'run-a', workspace: root })
  const operationId = store.intent('Bash', false)
  writeFileSync(join(root, 'effect'), 'performed')
  const recovered = RunStore.inspect(store.path)
  expect(recovered.status).toBe('needs_recovery')
  expect(recovered.operations[operationId].receipt).toBeUndefined()
  expect(readFileSync(join(root, 'effect'), 'utf8')).toBe('performed')
  store.receipt(operationId, 'completed')
  expect(RunStore.inspect(store.path).operations[operationId].receipt?.status).toBe('completed')
})

it('rejects stale run revisions instead of accepting a late receipt', () => {
  const root = directory()
  const store = new RunStore(root, { runId: 'run-a', workspace: root })
  const operationId = store.intent('Write', false)
  const changed = JSON.parse(readFileSync(store.path, 'utf8'))
  changed.revision++
  writeFileSync(store.path, JSON.stringify(changed))
  expect(() => store.receipt(operationId, 'completed')).toThrow(/ownership|revision/i)
})

it('serializes workspace owners and cancels a waiter without clearing the active lease', async () => {
  const root = directory()
  const first = await acquireWorkspaceLease(root, { stateRoot: root })
  const controller = new AbortController()
  const second = acquireWorkspaceLease(root, { stateRoot: root, signal: controller.signal })
  controller.abort()
  await expect(second).rejects.toBeDefined()
  expect(readWorkspaceLease(root, root)?.epoch).toBe(first.epoch)
  first.release()
  const next = await acquireWorkspaceLease(root, { stateRoot: root })
  expect(next.epoch).not.toBe(first.epoch)
  next.release()
})
