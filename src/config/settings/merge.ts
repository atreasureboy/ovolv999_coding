import type { HooksConfig, OvogoSettings } from './types.js'

const HOOK_NAMES = ['PreToolCall', 'PostToolCall', 'UserPromptSubmit', 'OnError', 'OnComplete', 'OnContextOverflow'] as const satisfies readonly (keyof HooksConfig)[]

function mergeHooks(global?: HooksConfig, project?: HooksConfig): HooksConfig {
  const hooks: HooksConfig = {}
  for (const name of HOOK_NAMES) hooks[name] = [...(global?.[name] ?? []), ...(project?.[name] ?? [])]
  return hooks
}

export function mergeSettingsLayers(global: OvogoSettings, project: OvogoSettings): OvogoSettings {
  return {
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
