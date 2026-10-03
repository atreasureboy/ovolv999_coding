import type { PermissionMode, PermissionRule } from '../../core/permissionSystem.js'
import type { McpServerConfig } from '../../core/mcpClient.js'

export interface HookEntry {
  
  matcher?: string
  
  command: string
}

export interface HooksConfig {
  PreToolCall?: HookEntry[]
  PostToolCall?: HookEntry[]
  UserPromptSubmit?: HookEntry[]
  OnError?: HookEntry[]
  OnComplete?: HookEntry[]
  OnContextOverflow?: HookEntry[]
}

export interface PermissionsConfig {
  
  mode?: PermissionMode
  
  rules?: PermissionRule[]
}

export interface TaskContext {
  
  name?: string
  
  phase?: string
  
  scope?: string[]
  
  notes?: string
}

export interface OvogoSettings {
  hooks?: HooksConfig
  taskContext?: TaskContext
  permissions?: PermissionsConfig
  poor?: { enabled: boolean }
  mcp?: { servers: McpServerConfig[] }
}
