import { afterEach, describe, expect, it, vi } from 'vitest'
import { McpModule } from '../src/modules/mcp.js'
import { McpStdioClient } from '../src/core/mcpClient.js'
import type { ModuleBootContext } from '../src/core/module.js'
import type { EngineConfig } from '../src/core/types.js'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const context = (): ModuleBootContext => ({
  cwd: process.cwd(),
  config: { mcp: { servers: [{ name: 'fake', type: 'stdio', command: ['fake'] }] } } as EngineConfig,
})

afterEach(() => vi.restoreAllMocks())

describe('MCP session ownership', () => {
  it('reuses one initialization across simultaneous boot and subsequent turns', async () => {
    const connect = vi.spyOn(McpStdioClient.prototype, 'connect').mockResolvedValue()
    const list = vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue([{ name: 'echo', inputSchema: {} }])
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue()
    const module = new McpModule()
    const ctx = context()
    const [first, second] = await Promise.all([module.boot(ctx), module.boot(ctx)])
    const third = await module.boot(ctx)
    expect(first.tools).toEqual(second.tools)
    expect(third.tools).toEqual(first.tools)
    expect(connect).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledTimes(1)
    await module.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes a client when connect succeeded but listTools failed', async () => {
    vi.spyOn(McpStdioClient.prototype, 'connect').mockResolvedValue()
    vi.spyOn(McpStdioClient.prototype, 'listTools').mockRejectedValue(new Error('list failed'))
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue()
    const module = new McpModule()
    await module.boot(context())
    expect(close).toHaveBeenCalledTimes(1)
    await module.dispose()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('reconnects only after effective server configuration changes and removes old clients', async () => {
    const connect = vi.spyOn(McpStdioClient.prototype, 'connect').mockResolvedValue()
    vi.spyOn(McpStdioClient.prototype, 'listTools').mockResolvedValue([{ name: 'echo', inputSchema: {} }])
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue()
    const module = new McpModule()
    const ctx = context()
    await module.boot(ctx)
    ctx.config.mcp!.servers[0].env = { CHANGED: 'yes' }
    await module.boot(ctx)
    expect(connect).toHaveBeenCalledTimes(2)
    expect(close).toHaveBeenCalledTimes(1)
    await module.boot({ ...ctx, config: {} as EngineConfig })
    expect(close).toHaveBeenCalledTimes(2)
  })

  it('does not wait indefinitely when an initializer ignores run cancellation', async () => {
    vi.spyOn(McpStdioClient.prototype, 'connect').mockImplementation(() => new Promise(() => undefined))
    const close = vi.spyOn(McpStdioClient.prototype, 'close').mockResolvedValue()
    const module = new McpModule()
    const controller = new AbortController()
    const boot = module.boot({ ...context(), abortSignal: controller.signal })
    const rejected = expect(boot).rejects.toThrow()
    await Promise.resolve()
    controller.abort()
    await rejected
    expect(close).toHaveBeenCalled()
    await module.dispose()
  })
})

describe('actual MCP child process lifecycle', () => {
  const fixture = fileURLToPath(new URL('./fixtures/mcpLifecycleServer.mjs', import.meta.url))
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function server(mode: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ovo-mcp-lifecycle-'))
    dirs.push(dir)
    const pidPath = join(dir, 'pid.txt')
    return { pidPath, config: { name: 'lifecycle', type: 'stdio' as const, command: [process.execPath, fixture, pidPath, mode] } }
  }

  async function waitForPid(path: string): Promise<number> {
    const deadline = Date.now() + 3_000
    while (!existsSync(path)) {
      if (Date.now() > deadline) throw new Error('MCP server did not start')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    return Number(readFileSync(path, 'utf8'))
  }

  function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true } catch { return false }
  }

  it('closes the actual server process when tools/list fails after handshake', async () => {
    const setup = server('fail-list')
    const module = new McpModule()
    const result = await module.boot({ cwd: process.cwd(), config: { mcp: { servers: [setup.config] } } as EngineConfig })
    const pid = await waitForPid(setup.pidPath)
    expect(result.tools ?? []).toEqual([])
    expect(alive(pid)).toBe(false)
    await module.dispose()
  })

  it('aborts a hanging initialize and awaits server exit before boot settles', async () => {
    const setup = server('hang-initialize')
    const module = new McpModule()
    const controller = new AbortController()
    const boot = module.boot({ cwd: process.cwd(), abortSignal: controller.signal, config: { mcp: { servers: [setup.config] } } as EngineConfig })
    const rejected = expect(boot).rejects.toThrow()
    const pid = await waitForPid(setup.pidPath)
    controller.abort()
    await rejected
    expect(alive(pid)).toBe(false)
    await module.dispose()
  })

  it('forwards tool cancellation and closes the server before returning the cancelled call', async () => {
    const setup = server('hang-tool')
    const client = new McpStdioClient(setup.config)
    await client.connect()
    const pid = await waitForPid(setup.pidPath)
    const controller = new AbortController()
    const call = client.callTool('hang', {}, controller.signal)
    const rejected = expect(call).rejects.toThrow(/cancelled/)
    controller.abort()
    await rejected
    expect(alive(pid)).toBe(false)
    await client.close()
  })
})
