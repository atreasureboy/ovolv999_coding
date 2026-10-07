import type { PermissionMode, PermissionRule } from '../../core/permissionSystem.js'
import type { McpServerConfig } from '../../core/mcpClient.js'
import type { ExecutionProfile } from '../../core/executionBackend.js'
import type { ExecutionPolicyInput } from '../../core/executionPolicy.js'
import type { ModelSettings } from '../modelSettings.js'

export interface HookEntry {
  
  matcher?: string
  
  command: string | readonly string[]
  kind?: 'notification' | 'policy'
  timeout?: number
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
  modelSettings?: Record<string, ModelSettings>
  executionPolicy?: ExecutionPolicyInput
  executionProfile?: ExecutionProfile
  hooks?: HooksConfig
  taskContext?: TaskContext
  permissions?: PermissionsConfig
  poor?: { enabled: boolean }
  mcp?: { servers: McpServerConfig[] }
}
