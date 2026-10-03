import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolContext } from '../../src/core/types.js'
import { FileWriteTool } from '../../src/tools/fileWrite.js'
import { ReadMcpResourceTool } from '../../src/tools/mcpResources.js'
import { EnterPlanModeTool } from '../../src/tools/enterPlanMode.js'

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'tool-data-')) })
afterEach(() => { vi.resetModules(); rmSync(cwd, { recursive: true, force: true }) })
const context = (): ToolContext => ({ cwd, permissionMode: 'auto' })

describe('tool data boundaries', () => {
  it('Write accurately reports UTF-8 bytes', async () => {
    const result = await new FileWriteTool().execute({ file_path: 'text.txt', content: '中文' }, context())
    expect(result.content).toContain('6 bytes')
  })

  it('Write reports zero lines for an empty file', async () => {
    const result = await new FileWriteTool().execute({ file_path: 'text.txt', content: '' }, context())
    expect(result.content).toContain('0 lines')
  })

  it('ReadMcpResource refuses an ambiguous URI instead of selecting the first server', async () => {
    const readResource = vi.fn(() => Promise.resolve([{ uri: 'shared://resource', text: 'wrong server selection' }]))
    const client = { listResources: () => Promise.resolve([{ uri: 'shared://resource' }]), readResource }
    const ctx = { ...context(), mcpRegistry: new Map([['first', { serverName: 'first', client }], ['second', { serverName: 'second', client }]]) } as unknown as ToolContext
    const result = await new ReadMcpResourceTool().execute({ uri: 'shared://resource' }, ctx)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/server/i)
    expect(readResource).not.toHaveBeenCalled()
  })

  it('EnterPlanMode cannot claim a mode change without an engine callback', async () => {
    expect((await new EnterPlanModeTool().execute({}, context())).isError).toBe(true)
  })

  it('TodoWrite can clear its checklist with an empty list', async () => {
    vi.resetModules()
    const { TodoWriteTool } = await import('../../src/tools/todo.js')
    const tool = new TodoWriteTool()
    await tool.execute({ todos: [{ id: '1', content: 'Do work', status: 'pending', priority: 'low' }] }, context())
    const result = await tool.execute({ todos: [] }, context())
    expect(result.content).toContain('(no tasks)')
  })

  it('TodoWrite handles null items without throwing', async () => {
    const { TodoWriteTool } = await import('../../src/tools/todo.js')
    await expect(new TodoWriteTool().execute({ todos: [null] }, context())).resolves.toMatchObject({ isError: true })
  })

  it('TodoWrite updates the active display text on a partial update', async () => {
    vi.resetModules()
    const { TodoWriteTool } = await import('../../src/tools/todo.js')
    const tool = new TodoWriteTool()
    await tool.execute({ todos: [{ id: '1', content: 'Work', activeForm: 'Working before', status: 'in_progress', priority: 'low' }, { id: '2', content: 'Next', status: 'pending', priority: 'low' }] }, context())
    const result = await tool.execute({ todos: [{ id: '1', content: 'Work', activeForm: 'Working now', status: 'in_progress', priority: 'low' }] }, context())
    expect(result.content).toContain('Working now')
  })
})
