import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { BackgroundTaskManager } from '../../src/core/backgroundTaskManager.js'

it('binds the durable task identity before starting a background process', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-task-binding-'))
  const manager = new BackgroundTaskManager()
  let bound = ''
  try {
    expect(() => manager.createTask(`"${process.execPath}" -e "process.exit(0)"`, { cwd, onCreated: id => {
      bound = id
      expect(manager.getTask(id)).toBeUndefined()
      throw new Error('durable resource binding refused')
    } })).toThrow('durable resource binding refused')
    expect(bound).toMatch(/^task_/)
    expect(manager.listTasks()).toEqual([])
  } finally {
    await manager.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
})
