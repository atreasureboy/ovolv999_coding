import { describe, expect, it, vi } from 'vitest'
import { GoalTool } from '../../src/tools/goal.js'
import { ListMcpResourcesTool, ReadMcpResourceTool } from '../../src/tools/mcpResources.js'
import { TerminalCaptureTool } from '../../src/tools/terminalCapture.js'
import type * as ExecutionBackend from '../../src/core/executionBackend.js'

const calls = vi.hoisted(() => [] as Array<{ command: string; args: string[] }>)
vi.mock('../../src/core/executionBackend.js', async importOriginal => ({
  ...await importOriginal<typeof ExecutionBackend>(),
  execManaged: (command: string, args: string[]) => { calls.push({ command, args }); return Promise.resolve({ stdout: 'fixture screen', stderr: '' }) },
}))

describe('tool discovery and capture boundaries', () => {
  it('allows completed and paused goal filters in its public schema', () => {
    const parameters = new GoalTool().definition.function.parameters as unknown as { properties: { status: { enum: string[] } } }
    expect(parameters.properties.status.enum).toEqual(expect.arrayContaining(['completed', 'paused']))
  })

  it('reports resource discovery errors while preserving successful prompts', async () => {
    const registry = new Map([['fixture', { serverName: 'fixture', client: {
      listResources: () => Promise.reject(new Error('transport disconnected')),
      listPrompts: () => Promise.resolve([{ name: 'available' }]),
      readResource: () => Promise.resolve([]),
    } }]])
    const result = await new ListMcpResourcesTool().execute({}, { cwd: process.cwd(), permissionMode: 'auto', mcpRegistry: registry } as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('transport disconnected')
    expect(result.content).toContain('/available')
    expect(result.content).not.toContain('Resources: none')
  })

  it('forwards caller cancellation to an explicit resource read', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled resource read'))
    const readResource = vi.fn((_uri: string, signal?: AbortSignal) => signal?.aborted ? Promise.reject(signal.reason instanceof Error ? signal.reason : new Error('cancelled resource read')) : Promise.resolve([{ uri: 'fixture://resource', text: 'uncancelled read' }]))
    const registry = new Map([['fixture', { serverName: 'fixture', client: { readResource } }]])
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, { cwd: process.cwd(), permissionMode: 'auto', signal: controller.signal, mcpRegistry: registry } as never)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cancelled resource read')
    expect(readResource).toHaveBeenCalledWith('fixture://resource', controller.signal)
  })

  it('uses the managed subprocess boundary for terminal capture', async () => {
    calls.length = 0
    const result = await new TerminalCaptureTool().execute({ target: 'fixture:0.1', lines: 20 }, { cwd: process.cwd(), permissionMode: 'auto' })
    expect(result.isError).toBe(false)
    expect(calls).toContainEqual({ command: 'tmux', args: ['capture-pane', '-t', 'fixture:0.1', '-S', '-20', '-E', '-', '-p'] })
  })
})
