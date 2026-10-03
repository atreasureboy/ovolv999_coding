import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { BackgroundTaskManager, formatTaskDetail } from '../../src/core/backgroundTaskManager.js'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from '../../src/core/processIdentity.js'
import { createProcessScope } from '../../src/core/executionBackend.js'

const pause = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 25))

describe('background task descendant accounting', () => {
  it('reports observed-only accounting when a detached descendant escapes discovery after normal root exit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'task-orphan-'))
    const manager = new BackgroundTaskManager({ sigkillGraceMs: 0 })
    const scope = createProcessScope()
    let leaf: ProcessIdentity | null = null
    try {
      const executable = process.platform === 'win32' ? 'node' : `"${process.execPath}"`
      const command = `${executable} "${resolve('tests/fixtures/task-orphan.mjs')}" root "${directory}"`
      const id = await scope.run(() => Promise.resolve(manager.createTask(command, { cwd: directory })))
      const readyDeadline = Date.now() + 8000
      while (!existsSync(join(directory, 'leaf.pid')) && Date.now() < readyDeadline) await pause()
      expect(existsSync(join(directory, 'leaf.pid')), manager.getTaskDetail(id)?.output).toBe(true)
      leaf = await captureProcessIdentity(Number(readFileSync(join(directory, 'leaf.pid'), 'utf8')))
      expect(leaf).not.toBeNull()
      writeFileSync(join(directory, 'exit-root'), '')
      const result = await manager.waitForTask(id, 5000)
      const descendantState = await inspectProcessIdentity(leaf!)
      manager.updateTask(id, { metadata: { processAccounting: 'full-tree-proven' } })
      const detail = manager.getTaskDetail(id)!
      expect(detail).toHaveProperty('processAccounting', 'observed-only')
      const formatted = formatTaskDetail(detail)
      expect(formatted).toContain('Completion covers observed processes')
      expect(formatted).toContain('termination of unobserved detached descendants is not confirmed')
      if (result?.status === 'completed' && scope.pending.size === 0 && descendantState === 'matching') {
        expect(result).toHaveProperty('processAccounting', 'observed-only')
      } else {
        expect(descendantState === 'dead' || scope.pending.size > 0).toBe(true)
      }
    } finally {
      writeFileSync(join(directory, 'exit-root'), '')
      writeFileSync(join(directory, 'stop-leaf'), '')
      const stopDeadline = Date.now() + 8000
      while (leaf && await inspectProcessIdentity(leaf) === 'matching' && Date.now() < stopDeadline) await pause()
      if (scope.pending.size > 0) await expect(manager.dispose()).rejects.toThrow('termination unconfirmed')
      else await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 25_000)

  it('physically stops descendants whose birth identities were recorded during execution', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'task-owned-descendant-'))
    const manager = new BackgroundTaskManager({ sigkillGraceMs: 0 })
    const scope = createProcessScope()
    let leaf: ProcessIdentity | null = null
    try {
      const executable = process.platform === 'win32' ? 'node' : `"${process.execPath}"`
      const command = `${executable} "${resolve('tests/fixtures/task-orphan.mjs')}" root "${directory}"`
      const id = await scope.run(() => Promise.resolve(manager.createTask(command, { cwd: directory })))
      const readyDeadline = Date.now() + 8000
      while (!existsSync(join(directory, 'leaf.pid')) && Date.now() < readyDeadline) await pause()
      leaf = await captureProcessIdentity(Number(readFileSync(join(directory, 'leaf.pid'), 'utf8')))
      expect(leaf).not.toBeNull()
      const discoveryDeadline = Date.now() + 8000
      while (Number(manager.getTask(id)?.metadata.trackedDescendants ?? 0) < 1 && Date.now() < discoveryDeadline) await pause()
      expect(Number(manager.getTask(id)?.metadata.trackedDescendants)).toBeGreaterThan(0)
      writeFileSync(join(directory, 'exit-root'), '')
      const result = await manager.waitForTask(id, 8000)
      expect(result?.status).toBe('failed')
      expect(await inspectProcessIdentity(leaf!)).toBe('dead')
      expect(scope.pending.size).toBe(0)
    } finally {
      writeFileSync(join(directory, 'exit-root'), '')
      writeFileSync(join(directory, 'stop-leaf'), '')
      const stopDeadline = Date.now() + 8000
      while (leaf && await inspectProcessIdentity(leaf) === 'matching' && Date.now() < stopDeadline) await pause()
      if (scope.pending.size > 0) await expect(manager.dispose()).rejects.toThrow('termination unconfirmed')
      else await manager.dispose()
      rmSync(directory, { recursive: true, force: true })
    }
  }, 25_000)
})
