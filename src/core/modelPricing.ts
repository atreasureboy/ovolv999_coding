import { MODELS } from './providers/registry.js'

export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachedInputPer1M?: number
  cacheWritePer1M?: number
}

export interface UsagePricing extends ModelPricing {
  version: string
}

const legacy: Record<string, ModelPricing> = {
  'gpt-4-turbo': { inputPer1M: 10, outputPer1M: 30 },
  'gpt-4': { inputPer1M: 30, outputPer1M: 60 },
  'gpt-3.5-turbo': { inputPer1M: 0.5, outputPer1M: 1.5 },
  'o1-pro': { inputPer1M: 150, outputPer1M: 600 },
  'claude-sonnet-4-6': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'claude-haiku-3-5': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-haiku': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-opus': { inputPer1M: 15, outputPer1M: 75 },
  'deepseek-coder': { inputPer1M: 0.14, outputPer1M: 0.28 },
}

export function getModelPricing(model: string): ModelPricing | null {
  const entries = [...MODELS.map(info => [info.id, info.pricing] as const), ...Object.entries(legacy)]
  const exact = entries.find(([id]) => id === model)
  if (exact) return { ...exact[1] }
  const match = entries.filter(([id]) => model.startsWith(id + '-')).sort(([a], [b]) => b.length - a.length)[0]
  return match ? { ...match[1] } : null
}

export function usagePricing(model: string): UsagePricing | null {
  const pricing = getModelPricing(model)
  return pricing ? { ...pricing, version: 'legacy-catalog-unverified' } : null
}
