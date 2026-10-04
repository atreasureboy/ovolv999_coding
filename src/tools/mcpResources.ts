/**
 * MCP Resource Tools
 *
 * Expose MCP server resources and prompts to the LLM.
 *   ListMcpResources — list resources/prompts from connected MCP servers
 *   ReadMcpResource  — read a specific resource by URI
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import type { McpRegistryEntry } from '../core/mcpRegistry.js'

// ── ListMcpResources ────────────────────────────────────────────────────────

export class ListMcpResourcesTool implements Tool {
  name = 'ListMcpResources'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ListMcpResources',
      description: `List resources and prompts exposed by connected MCP (Model Context Protocol) servers.

## When to Use
- Discover what data/files/context MCP servers can provide
- Find available prompt templates from MCP servers
- Explore MCP server capabilities before reading a specific resource

## Output
Lists resources (with URIs, names, descriptions) and prompts from each connected server.`,
      parameters: {
        type: 'object',
        properties: {
          server: {
            type: 'string',
            description: 'Filter to a specific MCP server name. Omit to list from all servers.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = ctx.mcpRegistry
    if (!registry || registry.size === 0) {
      return { content: 'No MCP servers connected.', isError: false }
    }

    const filterServer = input.server as string | undefined
    const lines: string[] = []
    let hasErrors = false

    for (const [name, entry] of registry) {
      if (filterServer && name !== filterServer) continue
      try {
        const [resourceResult, promptResult] = await Promise.allSettled([
          entry.client.listResources(ctx.signal),
          entry.client.listPrompts(ctx.signal),
        ])
        const resources = resourceResult.status === 'fulfilled' ? resourceResult.value : []
        const prompts = promptResult.status === 'fulfilled' ? promptResult.value : []

        lines.push(`\n=== ${name} ===`)

        if (resources.length > 0) {
          lines.push(`Resources (${resources.length}):`)
          for (const r of resources) {
            const desc = r.description ? ` — ${r.description}` : ''
            const mime = r.mimeType ? ` [${r.mimeType}]` : ''
            lines.push(`  ${r.uri}${mime}${desc}`)
          }
        } else if (resourceResult.status === 'rejected') {
          lines.push(`Resources: error (${resourceResult.reason instanceof Error ? resourceResult.reason.message : String(resourceResult.reason)})`)
          hasErrors = true
        } else {
          lines.push('Resources: none')
        }

        if (prompts.length > 0) {
          lines.push(`Prompts (${prompts.length}):`)
          for (const p of prompts) {
            const desc = p.description ? ` — ${p.description}` : ''
            const args = p.arguments?.map(a => `${a.name}${a.required ? '!' : ''}`).join(', ')
            lines.push(`  /${p.name}${args ? ` (${args})` : ''}${desc}`)
          }
        } else if (promptResult.status === 'rejected') {
          lines.push(`Prompts: error (${promptResult.reason instanceof Error ? promptResult.reason.message : String(promptResult.reason)})`)
          hasErrors = true
        }
      } catch (err) {
        hasErrors = true
        lines.push(`\n=== ${name} === (error: ${err instanceof Error ? err.message : String(err)})`)
      }
    }

    if (lines.length === 0) {
      return { content: filterServer ? `No MCP server named "${filterServer}".` : 'No MCP servers connected.', isError: false }
    }

    return { content: lines.join('\n'), isError: hasErrors }
  }
}

// ── ReadMcpResource ─────────────────────────────────────────────────────────

export class ReadMcpResourceTool implements Tool {
  name = 'ReadMcpResource'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ReadMcpResource',
      description: `Read a specific resource from a connected MCP server by its URI.

## When to Use
- Read a file/data source exposed by an MCP server
- Retrieve context that an MCP server provides (e.g., database schema, API docs)
- After using ListMcpResources to find the URI

## Parameters
- uri: The resource URI (from ListMcpResources)
- server: Optional server name (required if multiple servers expose the same URI)`,
      parameters: {
        type: 'object',
        properties: {
          uri: { type: 'string', description: 'The resource URI to read' },
          server: { type: 'string', description: 'Specific MCP server name (optional)' },
        },
        required: ['uri'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const registry = ctx.mcpRegistry
    if (!registry || registry.size === 0) {
      return { content: 'No MCP servers connected.', isError: true }
    }

    const uri = input.uri as string
    if (typeof uri !== 'string' || !uri) {
      return { content: 'Error: uri is required', isError: true }
    }

    const serverName = input.server as string | undefined

    // Find the server that has this resource
    let targetEntry: McpRegistryEntry | undefined
    let discoveryError: unknown
    if (serverName) {
      targetEntry = registry.get(serverName)
      if (!targetEntry) {
        return { content: `No MCP server named "${serverName}".`, isError: true }
      }
    } else {
      const matches: McpRegistryEntry[] = []
      // Search all servers for the URI
      for (const [, entry] of registry) {
        try {
          const resources = await entry.client.listResources(ctx.signal)
          ctx.signal?.throwIfAborted()
          if (resources.some(r => r.uri === uri)) {
            matches.push(entry)
          }
        } catch (error: unknown) {
          discoveryError = error
          if (ctx.signal?.aborted) {
            const reason: unknown = ctx.signal.reason
            return { content: `Failed to discover resource "${uri}": ${reason instanceof Error ? reason.message : 'MCP resource discovery cancelled'}`, isError: true }
          }
        }
      }
      if (matches.length > 1) return { content: `Resource "${uri}" is exposed by multiple servers. Specify server to choose the resource.`, isError: true }
      targetEntry = matches[0]
      if (!targetEntry) {
        // Fallback: try reading from the first server
        if (registry.size > 1) return { content: `Resource "${uri}" was not found. Specify server for a resource that is not listed.`, isError: true }
        targetEntry = registry.values().next().value
      }
    }

    if (!targetEntry) {
      return { content: `Failed to discover resource "${uri}": ${discoveryError instanceof Error ? discoveryError.message : 'No MCP servers connected.'}`, isError: true }
    }

    try {
      const contents = await targetEntry.client.readResource(uri, ctx.signal)
      if (contents.length === 0) {
        return { content: `Resource "${uri}" returned no content.`, isError: false }
      }

      const parts: string[] = []
      for (const c of contents) {
        const mime = c.mimeType ? ` [${c.mimeType}]` : ''
        if (c.text !== undefined) {
          parts.push(`=== ${c.uri}${mime} ===\n${c.text}`)
        } else if (c.blob !== undefined) {
          parts.push(`=== ${c.uri}${mime} ===\n[binary content: ${c.blob.length} bytes base64]`)
        }
      }

      return { content: parts.join('\n\n'), isError: false }
    } catch (err) {
      return {
        content: `Failed to read resource "${uri}": ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }
}
