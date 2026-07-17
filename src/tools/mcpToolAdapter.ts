/**
 * McpToolAdapter — wraps a single MCP tool as an ovolv999 `Tool`.
 *
 * The tool name is namespaced as `mcp__<server>__<tool>` to avoid collisions
 * with built-in tools and across multiple MCP servers. Calls are forwarded to
 * the owning McpStdioClient via tools/call.
 *
 * Metadata is intentionally conservative (non-readOnly, non-concurrent,
 * network-capable): MCP tool side effects are unknown to the host.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { McpStdioClient, McpToolInfo } from '../core/mcpClient.js'

function toObjectSchema(schema: unknown): ToolDefinition['function']['parameters'] {
  if (
    typeof schema === 'object' &&
    schema !== null &&
    (schema as { type?: string }).type === 'object' &&
    typeof (schema as { properties?: unknown }).properties === 'object'
  ) {
    return schema as ToolDefinition['function']['parameters']
  }
  return { type: 'object', properties: {} }
}

export class McpToolAdapter implements Tool {
  readonly name: string
  readonly metadata = {
    readOnly: false,
    concurrencySafe: false,
    requiresNetwork: true,
  }
  readonly definition: ToolDefinition

  constructor(
    private readonly serverName: string,
    private readonly toolInfo: McpToolInfo,
    private readonly client: McpStdioClient,
  ) {
    this.name = `mcp__${serverName}__${toolInfo.name}`
    this.definition = {
      type: 'function',
      function: {
        name: this.name,
        description: toolInfo.description?.trim() || `MCP tool ${toolInfo.name} from server ${serverName}`,
        parameters: toObjectSchema(toolInfo.inputSchema),
      },
    }
  }

  isConcurrencySafe(): boolean {
    return false
  }

  async execute(input: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = await this.client.callTool(this.toolInfo.name, input)
      return {
        content: result.content || `(MCP tool ${this.toolInfo.name} returned no text content)`,
        isError: result.isError,
      }
    } catch (err) {
      return {
        content: `MCP call ${this.name} failed: ${(err as Error).message}`,
        isError: true,
      }
    }
  }
}
