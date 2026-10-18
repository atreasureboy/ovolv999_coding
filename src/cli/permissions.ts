import {
  PermissionManager,
  type PermissionMode,
  type PermissionRule,
} from '../core/permissionSystem.js'
import type { EngineConfig } from '../core/types.js'
import { getProjectSettingsPath, saveProjectSettings } from '../config/settings.js'

export function persistCliPermissions(cwd: string, mode: PermissionMode, rules: PermissionRule[]): string {
  saveProjectSettings(cwd, { permissions: { mode, rules } })
  return getProjectSettingsPath(cwd)
}
export function createCliPermissionManager(
  permissions:
    | {
        mode?: PermissionMode
        rules?: PermissionRule[]
      }
    | undefined,
  permissionMode?: EngineConfig['permissionMode'],
): PermissionManager {
  const manager = new PermissionManager()
  manager.setMode(
    permissions?.mode ?? (permissionMode === 'auto' ? 'bypassPermissions' : 'default'),
  )
  for (const rule of permissions?.rules ?? []) manager.addRule(rule)
  return manager
}
