import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '../src/core/types.js'
import { BackgroundTaskManager, type TaskDetail } from '../src/core/backgroundTaskManager.js'
import { TaskGetTool, TaskStopTool, TaskUpdateTool } from '../src/tools/tasks.js'

function taskDetail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 'task-1',
    command: 'npm test',
    description: 'Run project tests',
    status: 'completed',
    exitCode: 0,
    pid: 123,
    startTime: 1000,
    endTime: 2000,
    durationMs: 1000,
    outputLength: 12,
    metadata: {},
    output: 'Tests passed',
    ...overrides,
  }
}

function taskContext(detail: TaskDetail | undefined = taskDetail()) {
  const manager = new BackgroundTaskManager()
  const getTaskDetail = vi.spyOn(manager, 'getTaskDetail').mockReturnValue(detail)
  const waitForTask = vi.spyOn(manager, 'waitForTask').mockResolvedValue(detail ?? null)
  const context: ToolContext = { cwd: process.cwd(), permissionMode: 'auto', backgroundTaskManager: manager }
  return { context, getTaskDetail, waitForTask }
}

const COMPLETED_OUTPUT = 'Task task-1: Run project tests\nStatus: completed (exit code: 0)\nCommand: npm test\nStarted: 1970-01-01T00:00:01.000Z\nEnded: 1970-01-01T00:00:02.000Z\nDuration: 1.0s\nPID: 123\nOutput (12 chars):\nTests passed'

describe('TaskGet tool contract', () => {
  const tool = new TaskGetTool()

  it('reports a missing manager before validating the task ID', async () => {
    expect(await tool.execute({}, { cwd: process.cwd(), permissionMode: 'auto' })).toEqual({
      content: 'Background task manager not available.',
      isError: true,
    })
  })

  it('requires a task ID', async () => {
    expect(await tool.execute({}, taskContext().context)).toEqual({
      content: 'Error: task_id is required',
      isError: true,
    })
  })

  it.each(['running', 'completed', 'failed'] as const)('returns %s details without treating status as a retrieval error', async status => {
    const detail = taskDetail({ status })
    const { context, waitForTask } = taskContext(detail)
    expect(await tool.execute({ task_id: detail.id }, context)).toEqual({
      content: COMPLETED_OUTPUT.replace('Status: completed', `Status: ${status}`),
      isError: false,
    })
    expect(waitForTask).not.toHaveBeenCalled()
  })

  it.each(['completed', 'failed'] as const)('returns %s details after blocking without a timeout suffix', async status => {
    const detail = taskDetail({ status })
    const { context, waitForTask } = taskContext(detail)
    expect(await tool.execute({ task_id: detail.id, block: true }, context)).toEqual({
      content: COMPLETED_OUTPUT.replace('Status: completed', `Status: ${status}`),
      isError: false,
    })
    expect(waitForTask).toHaveBeenCalledWith(detail.id, 30_000)
  })

  it('adds the timeout suffix based on the state returned by the wait', async () => {
    const detail = taskDetail()
    const { context, waitForTask } = taskContext(detail)
    waitForTask.mockResolvedValue(taskDetail({ status: 'running' }))
    expect(await tool.execute({ task_id: detail.id, block: true, timeout: 500_000 }, context)).toEqual({
      content: COMPLETED_OUTPUT + ' (timed out waiting)',
      isError: false,
    })
    expect(waitForTask).toHaveBeenCalledWith(detail.id, 300_000)
  })

  it.each([false, true])('reports a missing task with block=%s', async block => {
    const { context, getTaskDetail, waitForTask } = taskContext()
    getTaskDetail.mockReturnValue(undefined)
    waitForTask.mockResolvedValue(null)
    expect(await tool.execute({ task_id: 'missing', block }, context)).toEqual({
      content: 'Task not found: missing. Hint: use TaskList to see all task IDs.',
      isError: true,
    })
  })

  it('reports a task that disappears after its wait finishes', async () => {
    const { context, getTaskDetail } = taskContext()
    getTaskDetail.mockReturnValue(undefined)
    expect(await tool.execute({ task_id: 'task-1', block: true }, context)).toEqual({
      content: 'Task not found: task-1. Hint: use TaskList to see all task IDs.',
      isError: true,
    })
  })
})

describe('background task lookup errors', () => {
  it.each([new TaskUpdateTool(), new TaskStopTool()])('$name reports a missing task consistently', async tool => {
    const context: ToolContext = {
      cwd: process.cwd(), permissionMode: 'auto',
      backgroundTaskManager: new BackgroundTaskManager(),
    }
    expect(await tool.execute({ task_id: 'missing' }, context)).toEqual({
      content: 'Task not found: missing. Hint: use TaskList to see all task IDs.',
      isError: true,
    })
  })
})
