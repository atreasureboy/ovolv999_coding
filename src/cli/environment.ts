import { readFileSync } from 'fs'
export const VERSION = '0.1.0'
export interface ResolvedApiEnvironment {
  apiKey: string | undefined
  baseURL: string | undefined
  model: string
  provider: 'minimax' | 'openai'
}
export function resolveApiEnvironment(): ResolvedApiEnvironment {
  const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL
  const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
  const isMiniMax = Boolean(
    anthropicApiKey &&
    anthropicBaseURL &&
    /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
  )
  if (isMiniMax) {
    return {
      apiKey: anthropicApiKey,
      baseURL: anthropicBaseURL!.replace(/\/anthropic\/?$/i, '/v1'),
      model: process.env.OVOGO_MODEL ?? process.env.ANTHROPIC_MODEL ?? 'MiniMax-M3',
      provider: 'minimax',
    }
  }
  return {
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL,
    model: process.env.OVOGO_MODEL ?? 'gpt-4o',
    provider: 'openai',
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
