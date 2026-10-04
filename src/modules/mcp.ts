import { createHash } from 'crypto'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { Tool } from '../core/types.js'
import { McpStdioClient, type McpServerConfig } from '../core/mcpClient.js'
import type { McpRegistryEntry } from '../core/mcpRegistry.js'
import { McpToolAdapter } from '../tools/mcpToolAdapter.js'
import { currentExecutionPolicy } from '../core/executionBackend.js'
import { assertSupportedExecutionPolicy, normalizeExecutionPolicyInput, normalizeExecutionProfile, resolveManagedExecutionPolicy } from '../core/executionPolicy.js'

interface Connection {
  client: McpStdioClient
  controller: AbortController
  ready: Promise<Tool[]>
  entry?: McpRegistryEntry
}

function bounded<T>(operation: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('MCP operation cancelled'))
    const timer = setTimeout(() => finish(new Error('MCP operation timed out')), timeoutMs)
    function finish(error?: unknown, value?: T): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      if (error) reject(error instanceof Error ? error : new Error('MCP operation failed'))
      else resolve(value as T)
    }
    operation.then(value => finish(undefined, value), error => finish(error))
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

export class McpModule implements AgentModule {
  readonly name = 'mcp'
  private connections = new Map<string, Connection>()
  private registry = new Map<string, McpRegistryEntry>()
  private disposed = false
  private disposePromise?: Promise<void>
  private bootQueue: Promise<unknown> = Promise.resolve()

  boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    const snapshot = { ...ctx, config: { ...ctx.config, mcp: ctx.config.mcp ? { ...ctx.config.mcp, servers: ctx.config.mcp.servers.map(server => ({ ...server, command: [...server.command], env: server.env ? { ...server.env } : undefined })) } : undefined } }
    const task = this.bootQueue.then(() => this.refresh(snapshot))
    this.bootQueue = task.catch(() => undefined)
    return task
  }

  private async refresh(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    if (this.disposed) throw new Error('MCP module disposed')
    ctx.abortSignal?.throwIfAborted()
    const inheritedPolicy = resolveManagedExecutionPolicy(ctx.config.executionProfile, ctx.config.executionPolicy ?? currentExecutionPolicy(ctx.cwd), ctx.cwd)
    assertSupportedExecutionPolicy(inheritedPolicy)
    const servers = (ctx.config.mcp?.servers ?? []).map(server => {
      const requested = normalizeExecutionPolicyInput(server.executionPolicy ?? {})
      const legacy = server.executionProfile === undefined ? undefined : normalizeExecutionProfile(server.executionProfile)
      const cwd = server.cwd ?? ctx.cwd
      const executionPolicy = resolveManagedExecutionPolicy(legacy, {
        ...inheritedPolicy, ...requested,
        envAllowlist: requested.envAllowlist ?? [...inheritedPolicy.envAllowlist, ...(legacy?.envAllowlist ?? [])],
        limits: { ...inheritedPolicy.limits, ...requested.limits,
          processes: Math.min(inheritedPolicy.limits.processes, requested.limits?.processes ?? legacy?.maxProcesses ?? inheritedPolicy.limits.processes),
        },
      }, cwd)
      assertSupportedExecutionPolicy(executionPolicy)
      return { ...server, cwd, executionProfile: undefined, executionPolicy }
    })
    const names = new Set<string>()
    for (const server of servers) {
      if (names.has(server.name)) throw new Error(`Duplicate MCP server name: ${server.name}`)
      names.add(server.name)
    }
    const configured = servers.map(server => ({ server, key: createHash('sha256').update(JSON.stringify({ ...server, env: Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b)) })).digest('hex') }))
    const keys = new Set(configured.map(value => value.key))
    for (const [key, connection] of this.connections) {
      if (keys.has(key)) continue
      this.removeConnection(key, connection)
      connection.controller.abort()
      await this.close(connection.client)
    }
    const tools: Tool[] = []
    for (const { server, key } of configured) {
      ctx.abortSignal?.throwIfAborted()
      let connection = this.connections.get(key)
      if (connection?.client.isClosed) {
        this.removeConnection(key, connection)
        await this.close(connection.client)
        connection = undefined
      }
      if (!connection) {
        const client = new McpStdioClient(server)
        const controller = new AbortController()
        const signal = ctx.abortSignal ? AbortSignal.any([controller.signal, ctx.abortSignal]) : controller.signal
        connection = { client, controller, ready: this.initialize(server, client, signal) }
        this.connections.set(key, connection)
      }
      try {
        tools.push(...await connection.ready)
        if (!this.disposed && !connection.client.isClosed) {
          connection.entry ??= this.createEntry(server.name, key, connection)
          this.registry.set(server.name, connection.entry)
        }
      } catch {
        this.removeConnection(key, connection)
        ctx.abortSignal?.throwIfAborted()
        process.stderr.write(`[mcp] server "${server.name}" unavailable; initialization failed or timed out\n`)
      }
    }
    if (this.disposed) throw new Error('MCP module disposed')
    return { tools, toolContextPatch: { mcpRegistry: this.registry } }
  }

  private async initialize(server: McpServerConfig, client: McpStdioClient, signal: AbortSignal): Promise<Tool[]> {
    let ready = false
    try {
      await bounded(client.connect(signal), 15_000, signal)
      const infos = await bounded(client.listTools(signal), 15_000, signal).catch((error: unknown) => {
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === -32601) return []
        throw error
      })
      signal.throwIfAborted()
      const tools = infos.map(info => new McpToolAdapter(server.name, info, client))
      ready = true
      return tools
    } finally {
      if (!ready) await this.close(client)
    }
  }

  private createEntry(serverName: string, key: string, connection: Connection): McpRegistryEntry {
    const client = connection.client
    return {
      serverName,
      client: {
        listResources: signal => this.resourceOperation(key, connection, () => client.listResources(signal)),
        readResource: (uri, signal) => this.resourceOperation(key, connection, () => client.readResource(uri, signal)),
        listPrompts: signal => this.resourceOperation(key, connection, () => client.listPrompts(signal)),
      },
    }
  }

  private async resourceOperation<T>(key: string, connection: Connection, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } finally {
      if (connection.client.isClosed) {
        this.removeConnection(key, connection)
        await this.close(connection.client)
      }
    }
  }

  private removeConnection(key: string, connection: Connection): void {
    if (this.connections.get(key) === connection) this.connections.delete(key)
    const entry = connection.entry
    if (entry && this.registry.get(entry.serverName) === entry) this.registry.delete(entry.serverName)
  }

  private async close(client: McpStdioClient): Promise<void> {
    try {
      await bounded(client.close(), 2_500)
    } catch {
      process.stderr.write('[mcp] cleanup incomplete: a server did not confirm shutdown\n')
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    const connections = [...this.connections.values()]
    this.connections.clear()
    this.registry.clear()
    for (const connection of connections) connection.controller.abort()
    this.disposePromise = Promise.all(connections.map(connection => this.close(connection.client))).then(() => undefined)
    return this.disposePromise
  }
}

export type { McpServerConfig }
