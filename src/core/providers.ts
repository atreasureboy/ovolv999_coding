import { MODELS, MODEL_INDEX, PROVIDERS } from './providers/registry.js'
import type { ModelInfo, ProviderId, ProviderInfo } from './providers/types.js'

export { MODELS, PROVIDERS }
export type { ModelInfo, ProviderId, ProviderInfo } from './providers/types.js'
export { detectProvider, detectProviderFromBaseURL, detectProviderFromEnv, detectProviderFromModel } from './providers/detection.js'

export function getModelInfo(model: string): ModelInfo | null {
  const exact = MODEL_INDEX.get(model)
  if (exact) return exact

  const slashIdx = model.indexOf('/')
  if (slashIdx > 0) {
    const withoutPrefix = model.slice(slashIdx + 1)
    const found = MODEL_INDEX.get(withoutPrefix)
    if (found) return found
  }

  return null
}

export function getContextWindow(model: string): number {
  const info = getModelInfo(model)
  return info?.contextWindow ?? 128_000
}

export function getModelPricing(model: string): { inputPer1M: number; outputPer1M: number } {
  const info = getModelInfo(model)
  return info?.pricing ?? { inputPer1M: 0, outputPer1M: 0 }
}

const CAPABILITY_FIELDS = {
  vision: 'supportsVision',
  tools: 'supportsTools',
  parallelTools: 'supportsParallelTools',
  reasoning: 'supportsReasoning',
} as const satisfies Record<string, keyof ModelInfo>

export function modelSupports(model: string, capability: keyof typeof CAPABILITY_FIELDS): boolean {
  const info = getModelInfo(model)
  return info ? info[CAPABILITY_FIELDS[capability]] ?? false : capability === 'tools'
}

export function getProvider(id: ProviderId): ProviderInfo {
  return PROVIDERS[id] ?? PROVIDERS.unknown
}

export function listProviders(): ProviderId[] {
  return Object.keys(PROVIDERS).filter(k => k !== 'unknown') as ProviderId[]
}

export function getProviderBaseURL(provider: ProviderId): string | null {
  return PROVIDERS[provider]?.baseURL ?? null
}

export function getProviderAPIKeyEnv(provider: ProviderId): string | null {
  return PROVIDERS[provider]?.apiKeyEnv ?? null
}
