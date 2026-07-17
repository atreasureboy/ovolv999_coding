/**
 * McpModule — dynamically injects MCP server tools into the engine.
 *
 * At boot, reads `config.mcp.servers`, connects each stdio server, lists its
 * tools, and returns them (wrapped via McpToolAdapter) as module-provided
 * tools. The engine merges these into the tool set, so the LLM can call
 * `mcp__<server>__<tool>` like any built-in tool.
 *
 * Connection failures are isolated: one broken server logs a warning and is
 * skipped — it never blocks the boot sequence.
 *
 * Lifecycle: dispose() closes every connected stdio client so the server
 * processes don't outlive the engine. The engine calls this from its own
 * dispose() method (Engine.dispose → McpModule.dispose). Best-effort —
 * individual close failures are swallowed to keep shutdown robust. The
 * module's onComplete() is intentionally NOT used to close the clients,
 * because onComplete fires after every turn — closing there would sever
 * the connections between user prompts and break subsequent tool calls.
 */

import type { AgentModule, ModuleBootContext, ModuleBootResult } from '../core/module.js'
import type { Tool } from '../core/types.js'
import { McpStdioClient, type McpServerConfig } from '../core/mcpClient.js'
import { McpToolAdapter } from '../tools/mcpToolAdapter.js'

export class McpModule implements AgentModule {
  readonly name = 'mcp'

  private clients: McpStdioClient[] = []

  async boot(ctx: ModuleBootContext): Promise<ModuleBootResult> {
    const servers = ctx.config.mcp?.servers ?? []
    if (servers.length === 0) return {}

    const tools: Tool[] = []
    for (const server of servers) {
      try {
        const client = new McpStdioClient(server)
        await client.connect()
        const toolInfos = await client.listTools()
        this.clients.push(client)
        for (const info of toolInfos) {
          tools.push(new McpToolAdapter(server.name, info, client))
        }
      } catch (err) {
        // Isolate failures: warn and continue. Never block boot.
        process.stderr.write(
          `[mcp] failed to connect server "${server.name}" (${server.command.join(' ')}): ${(err as Error).message}\n`,
        )
      }
    }

    return tools.length > 0 ? { tools } : {}
  }

  /**
   * Tear down connected MCP server processes. Without this hook the stdio
   * servers spawned at boot would outlive the engine and only exit when
   * the host process terminates — a process leak per MCP-equipped engine.
   * Best-effort: any close failure on an individual client is swallowed so
   * one stubborn server can't keep others alive. Idempotent.
   */
  async dispose(): Promise<void> {
    const clients = this.clients
    this.clients = []
    for (const client of clients) {
      try {
        await client.close()
      } catch {
        // best-effort cleanup — never let one stuck client block shutdown
      }
    }
  }
}

export type { McpServerConfig }
