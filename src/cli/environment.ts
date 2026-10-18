import { readFileSync } from 'fs'
import { normalizeModelProtocol } from '../config/modelSettings.js'
import type { ModelProtocol } from '../core/model/types.js'
export const VERSION = '0.1.0'
export interface ResolvedApiEnvironment {
  apiKey: string | undefined
  baseURL: string | undefined
  model: string
  provider: 'minimax' | 'openai' | 'anthropic'
  protocol: ModelProtocol
}
export function resolveApiEnvironment(configuredProtocol?: ModelProtocol, env: NodeJS.ProcessEnv = process.env): ResolvedApiEnvironment {
  const protocol = configuredProtocol ?? (env.OVOGO_MODEL_PROTOCOL ? normalizeModelProtocol(env.OVOGO_MODEL_PROTOCOL) : undefined)
  const anthropicBaseURL = env.ANTHROPIC_BASE_URL
  const anthropicApiKey = env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY
  if (protocol === 'anthropic') {
    return {
      apiKey: anthropicApiKey,
      baseURL: anthropicBaseURL ?? 'https://api.anthropic.com/v1',
      model: env.OVOGO_MODEL ?? env.ANTHROPIC_MODEL ?? '',
      provider: 'anthropic',
      protocol,
    }
  }
  const isMiniMax = Boolean(
    anthropicApiKey &&
    anthropicBaseURL &&
    /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
  )
  if (isMiniMax) {
    return {
      apiKey: anthropicApiKey,
      baseURL: anthropicBaseURL!.replace(/\/anthropic\/?$/i, '/v1'),
      model: env.OVOGO_MODEL ?? env.ANTHROPIC_MODEL ?? 'MiniMax-M3',
      provider: 'minimax',
      protocol: protocol ?? 'chat-completions',
    }
  }
  return {
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.OPENAI_BASE_URL,
    model: env.OVOGO_MODEL ?? 'gpt-4o',
    provider: 'openai',
    protocol: protocol ?? 'chat-completions',
  }
}
export function buildVersion(entryUrl: string): string {
  try {
    const identity = JSON.parse(readFileSync(new URL('../build-info.json', entryUrl), 'utf8')) as {
      version?: unknown
      gitCommit?: unknown
      sourceDirty?: unknown
    }
    if (
      typeof identity.version === 'string' &&
      typeof identity.gitCommit === 'string' &&
      /^[a-f0-9]{40}$/.test(identity.gitCommit)
    ) {
      return `${identity.version} (ovolv999) ${identity.gitCommit}${identity.sourceDirty ? ' dirty' : ''}`
    }
  } catch (error) {
    void error
  }
  return `${VERSION} (ovolv999) source-checkout`
}
