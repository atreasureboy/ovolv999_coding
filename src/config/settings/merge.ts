import type { HooksConfig, OvogoSettings } from './types.js'
import type { ExecutionPolicyInput } from '../../core/executionPolicy.js'
import { mergeModelSettings } from '../modelSettings.js'

function mergeExecutionPolicy(base?: ExecutionPolicyInput, override?: ExecutionPolicyInput): ExecutionPolicyInput | undefined {
  if (!override) return base
  return { ...base, ...override, ...(base?.limits || override.limits ? { limits: { ...base?.limits, ...override.limits } } : {}) }
}

const HOOK_NAMES = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const satisfies readonly (keyof HooksConfig)[]

function mergeHooks(global?: HooksConfig, project?: HooksConfig): HooksConfig {
  const hooks: HooksConfig = {}
  for (const name of HOOK_NAMES) hooks[name] = [...(global?.[name] ?? []), ...(project?.[name] ?? [])]
  return hooks
}

export function mergeSettingsLayers(global: OvogoSettings, project: OvogoSettings): OvogoSettings {
  return {
    modelSettings: mergeModelSettings(global.modelSettings, project.modelSettings),
    executionPolicy: mergeExecutionPolicy(global.executionPolicy, project.executionPolicy),
    executionProfile: project.executionProfile ?? global.executionProfile,
    hooks: mergeHooks(global.hooks, project.hooks),
    taskContext: project.taskContext
      ? {
          ...(global.taskContext ?? {}),
          ...project.taskContext,
          scope: project.taskContext.scope ?? global.taskContext?.scope,
        }
      : global.taskContext,
    permissions: global.permissions || project.permissions
      ? {
          mode: project.permissions?.mode ?? global.permissions?.mode,
          rules: [...(global.permissions?.rules ?? []), ...(project.permissions?.rules ?? [])],
        }
      : undefined,
    poor: project.poor ?? global.poor,
    mcp: project.mcp ?? global.mcp,
  }
}

export function applySettingsPatch(current: OvogoSettings, patch: OvogoSettings): OvogoSettings {
  return {
    ...current,
    ...patch,
    modelSettings: mergeModelSettings(current.modelSettings, patch.modelSettings),
    executionPolicy: mergeExecutionPolicy(current.executionPolicy, patch.executionPolicy),
    executionProfile: patch.executionProfile ?? current.executionProfile,
    hooks: patch.hooks ?? current.hooks,
    taskContext: patch.taskContext ?? current.taskContext,
    permissions: patch.permissions
      ? {
          ...(current.permissions ?? {}),
          ...patch.permissions,
          rules: patch.permissions.rules ?? current.permissions?.rules,
        }
      : current.permissions,
  }
}
