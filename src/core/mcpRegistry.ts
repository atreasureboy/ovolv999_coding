import type { McpStdioClient } from './mcpClient.js'

export interface McpRegistryEntry {
  readonly serverName: string
  readonly client: Pick<McpStdioClient, 'listResources' | 'readResource' | 'listPrompts'>
}
