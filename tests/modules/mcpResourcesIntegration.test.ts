import type OpenAI from 'openai'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../src/core/engine.js'
import { globalModuleRegistry } from '../../src/core/moduleRegistry.js'
import type { ModuleBootResult } from '../../src/core/module.js'
import type { McpServerConfig } from '../../src/core/mcpClient.js'
import type { EngineConfig, ToolContext } from '../../src/core/types.js'
import { McpModule } from '../../src/modules/mcp.js'
import { ListMcpResourcesTool, ReadMcpResourceTool } from '../../src/tools/mcpResources.js'
import type { Renderer } from '../../src/ui/renderer.js'

const fixture = fileURLToPath(new URL('../fixtures/mcpResourcesServer.mjs', import.meta.url))
const directories: string[] = []
const disposables: Array<{ dispose(): Promise<void> }> = []

afterEach(async () => {
  for (const value of disposables.splice(0)) await value.dispose()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function server(mode = 'normal', name = 'fixture', label = name): { config: McpServerConfig; cwd: string; pidPath: string; requestPath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-mcp-resources-'))
  directories.push(cwd)
  const pidPath = join(cwd, 'server.pid')
  const requestPath = join(cwd, 'requests.txt')
  return { cwd, pidPath, requestPath, config: { name, type: 'stdio', command: [process.execPath, fixture, mode, label, pidPath, requestPath] } }
}

function module() {
  const value = new McpModule()
  disposables.push(value)
  return value
}

function boot(value: McpModule, servers: McpServerConfig[]): Promise<ModuleBootResult> {
  return value.boot({ cwd: process.cwd(), config: { mcp: { servers } } as EngineConfig })
}

function context(result: ModuleBootResult, signal?: AbortSignal): ToolContext {
  return { cwd: process.cwd(), permissionMode: 'auto', ...result.toolContextPatch, signal }
}

function alive(pidPath: string): boolean {
  if (!existsSync(pidPath)) return false
  try { process.kill(Number(readFileSync(pidPath, 'utf8')), 0); return true } catch { return false }
}

async function waitForRequest(path: string, method: string): Promise<void> {
  await vi.waitFor(() => expect(existsSync(path) && readFileSync(path, 'utf8').split('\n').includes(method)).toBe(true), { timeout: 3_000, interval: 10 })
}

function engine(setup: ReturnType<typeof server>, calls: Array<{ name: string; input?: Record<string, unknown> }>) {
  let requestCount = 0
  const requests: OpenAI.Chat.ChatCompletionCreateParamsStreaming[] = []
  const client = { chat: { completions: { create: (params: OpenAI.Chat.ChatCompletionCreateParamsStreaming) => {
    requests.push(params)
    const step = requestCount++
    return Promise.resolve((async function* () {
      await Promise.resolve()
      yield { choices: [{ delta: step === 0 ? {
        tool_calls: calls.map((call, index) => ({ index, id: `mcp-call-${index}`, function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) } })),
      } : { content: 'MCP turn complete' }, finish_reason: step === 0 ? 'tool_calls' : 'stop' }] }
    })())
  } } } } as unknown as OpenAI
  globalModuleRegistry.register('mcp', () => new McpModule())
  const renderer = new Proxy({}, { get: () => vi.fn() }) as Renderer
  const value = new ExecutionEngine({ cwd: setup.cwd, model: 'gpt-4o', apiKey: 'offline', maxIterations: 3, permissionMode: 'auto', enabledModules: ['mcp'], mcp: { servers: [setup.config] } }, renderer, client)
  disposables.push(value)
  return { value, requests }
}

describe('MCP resources through module and Engine wiring', () => {
  it('calls a real MCP tool, discovers resources and reads a resource in one Engine turn', async () => {
    const setup = server()
    const { value, requests } = engine(setup, [
      { name: 'mcp__fixture__echo', input: { text: 'hello' } },
      { name: 'ListMcpResources' },
      { name: 'ReadMcpResource', input: { uri: 'fixture://resource', server: 'fixture' } },
    ])
    const turn = await value.runTurn('inspect MCP capabilities', [])
    const results = turn.newHistory.filter(message => message.role === 'tool').map(message => message.content)
    expect(results).toHaveLength(3)
    expect(results[0]).toBe('fixture: hello')
    expect(results[1]).toContain('fixture://resource')
    expect(results[1]).toContain('/explain (topic!)')
    expect(results[2]).toContain('fixture resource body')
    expect(turn.result).toMatchObject({ status: 'blocked', verification: { status: 'not_applicable', sufficientForCompletion: false } })
    expect(requests[0].tools?.map(tool => tool.function.name)).toContain('mcp__fixture__echo')
    await value.dispose()
    expect(alive(setup.pidPath)).toBe(false)
  })

  it('connects a resource-only server without requiring tools/list support', async () => {
    const setup = server('resource-only')
    const { value, requests } = engine(setup, [
      { name: 'ListMcpResources' },
      { name: 'ReadMcpResource', input: { uri: 'fixture://resource' } },
    ])
    const turn = await value.runTurn('read resource-only server', [])
    const results = turn.newHistory.filter(message => message.role === 'tool').map(message => message.content)
    expect(results[0]).toContain('fixture://resource')
    expect(results[1]).toContain('fixture resource body')
    expect(requests[0].tools?.map(tool => tool.function.name)).not.toContain('mcp__fixture__echo')
  })

  it('invalidates old registry entries on reconfiguration, removal and disposal', async () => {
    const first = server('normal', 'fixture', 'before')
    const second = server('normal', 'fixture', 'after')
    const value = module()
    const initial = await boot(value, [first.config])
    const initialContext = context(initial)
    const replaced = await boot(value, [second.config])
    expect(alive(first.pidPath)).toBe(false)
    expect((await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, initialContext)).content).toContain('after resource body')
    await boot(value, [])
    expect((await new ListMcpResourcesTool().execute({}, context(replaced))).content).toBe('No MCP servers connected.')
    expect(alive(second.pidPath)).toBe(false)
    const restarted = await boot(value, [second.config])
    await value.dispose()
    expect((await new ListMcpResourcesTool().execute({}, context(restarted))).content).toBe('No MCP servers connected.')
    expect(alive(second.pidPath)).toBe(false)
  })

  it('rejects duplicate server names before replacing a working connection', async () => {
    const first = server()
    const duplicate = server('normal', 'fixture', 'duplicate')
    const value = module()
    const initial = await boot(value, [first.config])
    await expect(boot(value, [first.config, duplicate.config])).rejects.toThrow(/duplicate.*fixture/i)
    expect(existsSync(duplicate.pidPath)).toBe(false)
    expect(alive(first.pidPath)).toBe(true)
    expect((await new ReadMcpResourceTool().execute({ uri: 'fixture://resource' }, context(initial))).content).toContain('fixture resource body')
  })

  it('preserves discovery server errors through the connected registry', async () => {
    const setup = server('fail-resources')
    const result = await new ListMcpResourcesTool().execute({}, context(await boot(module(), [setup.config])))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Resource discovery unavailable')
    expect(result.content).toContain('/explain')
  })

  it('preserves read server errors through the connected registry', async () => {
    const setup = server('fail-read')
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, context(await boot(module(), [setup.config])))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('Resource read denied')
  })

  it('retains the frame limit when reading through the connected registry', async () => {
    const setup = server('oversized-read')
    setup.config.limits = { maxFrameBytes: 4096 }
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, context(await boot(module(), [setup.config])))
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/frame.*limit/i)
  })

  it('forwards cancellation and leaves the connection usable after a cancelled read', async () => {
    const setup = server('hang-read')
    const controller = new AbortController()
    const ready = await boot(module(), [setup.config])
    const read = new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, context(ready, controller.signal))
    await waitForRequest(setup.requestPath, 'resources/read')
    controller.abort(new Error('cancelled fixture read'))
    const result = await read
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cancelled fixture read')
    expect((await new ListMcpResourcesTool().execute({}, context(ready))).content).toContain('fixture://resource')
  })

  it('removes a disconnected server from the registry after a failed resource read', async () => {
    const setup = server('exit-read')
    const ready = await boot(module(), [setup.config])
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, context(ready))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('exited')
    expect((await new ListMcpResourcesTool().execute({}, context(ready))).content).toBe('No MCP servers connected.')
    expect(alive(setup.pidPath)).toBe(false)
  })

  it('reports a server disconnect during implicit resource discovery', async () => {
    const setup = server('exit-discovery')
    const ready = await boot(module(), [setup.config])
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource' }, context(ready))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('exited')
    expect((await new ListMcpResourcesTool().execute({}, context(ready))).content).toBe('No MCP servers connected.')
  })

  it('preserves cancellation while discovering an implicit resource server', async () => {
    const first = server('hang-discovery', 'first')
    const second = server('normal', 'second')
    const controller = new AbortController()
    const ready = await boot(module(), [first.config, second.config])
    const read = new ReadMcpResourceTool().execute({ uri: 'fixture://resource' }, context(ready, controller.signal))
    await waitForRequest(first.requestPath, 'resources/list')
    controller.abort(new Error('cancelled resource discovery'))
    const result = await read
    expect(result.isError).toBe(true)
    expect(result.content).toContain('cancelled resource discovery')
    expect(readFileSync(second.requestPath, 'utf8')).not.toContain('resources/list')
    expect(readFileSync(second.requestPath, 'utf8')).not.toContain('resources/read')
  })

  it('settles pending resource reads and clears the registry when disposed', async () => {
    const setup = server('hang-read')
    const value = module()
    const ready = await boot(value, [setup.config])
    const read = new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'fixture' }, context(ready))
    await waitForRequest(setup.requestPath, 'resources/read')
    await value.dispose()
    expect(await read).toMatchObject({ isError: true })
    expect((await new ListMcpResourcesTool().execute({}, context(ready))).content).toBe('No MCP servers connected.')
    expect(alive(setup.pidPath)).toBe(false)
  })

  it('refuses a shared URI without choosing between connected servers', async () => {
    const first = server('normal', 'first')
    const second = server('normal', 'second')
    const ready = await boot(module(), [first.config, second.config])
    const result = await new ReadMcpResourceTool().execute({ uri: 'fixture://resource' }, context(ready))
    expect(result.isError).toBe(true)
    expect(result.content).toContain('multiple servers')
    expect(readFileSync(first.requestPath, 'utf8')).not.toContain('resources/read')
    expect(readFileSync(second.requestPath, 'utf8')).not.toContain('resources/read')
    expect((await new ReadMcpResourceTool().execute({ uri: 'fixture://resource', server: 'second' }, context(ready))).content).toContain('second resource body')
  })
})
