import { describe, expect, it } from 'vitest'
import { BackgroundTaskManager } from '../../src/core/backgroundTaskManager.js'
import type { ToolContext } from '../../src/core/types.js'
import { TaskCreateTool } from '../../src/tools/tasks.js'
import { TmuxSessionTool } from '../../src/tools/tmuxSession.js'

describe('task execution policy', () => {
  it('does not start a TaskCreate command after parent cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const manager = new BackgroundTaskManager()
    const context: ToolContext = { cwd: process.cwd(), permissionMode: 'auto', backgroundTaskManager: manager, signal: controller.signal }
    const result = await new TaskCreateTool().execute({ command: 'echo unexpected' }, context)
    expect(result.isError).toBe(true)
    expect(manager.listTasks().every(task => task.pid === undefined)).toBe(true)
    await manager.dispose()
  })

  it('rejects TaskCreate when the requested process isolation is unavailable', async () => {
    const manager = new BackgroundTaskManager()
    const context: ToolContext = { cwd: process.cwd(), permissionMode: 'auto', backgroundTaskManager: manager, executionProfile: { mode: 'isolated-worker' } }
    try {
      await expect(new TaskCreateTool().execute({ command: 'echo unexpected' }, context)).resolves.toMatchObject({ isError: true })
    } finally {
      await manager.dispose()
    }
  })

  it('rejects tmux queries when process isolation is unavailable', async () => {
    const context: ToolContext = { cwd: process.cwd(), permissionMode: 'auto', executionProfile: { mode: 'isolated-worker' } }
    const result = await new TmuxSessionTool().execute({ action: 'list' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/isolation/i)
  })
})
