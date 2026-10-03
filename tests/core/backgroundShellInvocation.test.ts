import { expect, it } from 'vitest'
import { BackgroundTaskManager } from '../../src/core/backgroundTaskManager.js'

it('runs an explicitly quoted executable path through the platform shell', async () => {
  const manager = new BackgroundTaskManager()
  try {
    const id = manager.createTask(`"${process.execPath}" -e "console.log('quoted-executable-ok')"`)
    const task = await manager.waitForTask(id, 8000)
    expect(task?.exitCode).toBe(0)
    expect(manager.getTaskDetail(id)?.output).toContain('quoted-executable-ok')
  } finally {
    await manager.dispose().catch(() => {})
  }
}, 15_000)
