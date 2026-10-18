import { loadProjectConfig, type ProjectConfig } from '../config/projectConfig.js'
import type { ModelSettings } from '../config/modelSettings.js'
import { loadSettings } from '../config/settings.js'
import { getActiveProfile, type Profile } from '../core/profiles.js'
import type { EngineConfig } from '../core/types.js'
import type { ExecutionEngine, RuntimeConfigurationPatch } from '../core/engine.js'
import type { PermissionMode } from '../core/permissionSystem.js'
import { resolveApiEnvironment } from './environment.js'
import { createCliPermissionManager } from './permissions.js'

export function createRuntimeConfigurationResolver(cwd: string, options: {
  model: string
  modelExplicit?: boolean
  projectConfig?: ProjectConfig | null
  modelSettings?: Record<string, ModelSettings>
  env?: NodeJS.ProcessEnv
}): () => RuntimeConfigurationPatch & Pick<EngineConfig, 'model' | 'apiKey' | 'permissionMode'> {
  const baselineEnvironment = { ...(options.env ?? process.env) }
  return () => {
    const profile = getActiveProfile(cwd)
    const env = { ...baselineEnvironment, ...profile?.env }
    const model = options.modelExplicit ? options.model
      : profile?.provider?.model ?? profile?.env?.OVOGO_MODEL ?? profile?.env?.ANTHROPIC_MODEL ?? options.projectConfig?.model ?? options.model
    const protocol = options.modelSettings?.[model]?.protocol
      ?? (profile?.provider ? profile.provider.name === 'anthropic' ? 'anthropic' : 'chat-completions' : undefined)
    const apiEnv = profile?.provider && profile.provider.name !== 'minimax' && protocol !== 'anthropic'
      ? { ...env, ANTHROPIC_AUTH_TOKEN: undefined, ANTHROPIC_API_KEY: undefined } : env
    const api = resolveApiEnvironment(protocol, apiEnv)
    const apiKey = profile?.provider?.apiKeyEnv ? env[profile.provider.apiKeyEnv] : api.apiKey
    if (profile?.provider?.apiKeyEnv && !apiKey) throw new Error(`Profile API key environment variable is not set: ${profile.provider.apiKeyEnv}`)
    return {
      model,
      modelProtocol: api.protocol,
      apiKey: apiKey ?? '',
      baseURL: profile?.provider?.baseUrl ?? api.baseURL,
      temperature: profile?.modelPrefs?.temperature
        ?? (profile?.env?.OVOGO_TEMPERATURE ? Number(profile.env.OVOGO_TEMPERATURE) : undefined)
        ?? options.projectConfig?.temperature
        ?? (env.OVOGO_TEMPERATURE ? Number(env.OVOGO_TEMPERATURE) : undefined),
      maxOutputTokens: profile?.modelPrefs?.maxTokens ?? (env.OVOGO_MAX_OUTPUT_TOKENS ? Number(env.OVOGO_MAX_OUTPUT_TOKENS) : undefined),
      permissionMode: options.projectConfig?.permissionMode ?? 'auto',
      requireToolApproval: profile?.permissionLevel === 'strict',
    }
  }
}

export function applyActiveProfile(engine: ExecutionEngine, cwd: string): void {
  const config = engine.getConfig()
  const profile = getActiveProfile(cwd)
  const resolve = config.resolveRuntimeConfiguration
  if (!resolve) throw new Error('Live profile switching is unavailable for this engine')
  const settings = loadSettings(cwd)
  const manager = engine.getPermissionManager()
  const mode = resolveProfilePermissionMode(profile, settings.permissions?.mode,
    createCliPermissionManager(undefined, loadProjectConfig(cwd)?.permissionMode).getMode())
  engine.applyRuntimeConfiguration(resolve())
  if (!config.planMode) manager.setMode(mode)
}

export function resolveProfilePermissionMode(profile: Profile | null, explicitMode: PermissionMode | undefined, fallback: PermissionMode): PermissionMode {
  return explicitMode ?? (profile?.permissionLevel === 'permissive' ? 'bypassPermissions' : fallback)
}
