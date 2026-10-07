import type { AdapterEffort, ModelCapabilities, ModelProtocol } from '../core/model/types.js'
import type { UsagePricing } from '../core/modelPricing.js'
import { isEffortLevel } from '../core/effort.js'
import { ExecutionPolicyError } from '../core/executionPolicy.js'

export interface ModelSettings {
  protocol?: ModelProtocol
  capabilities?: Partial<ModelCapabilities>
  effort?: AdapterEffort
  pricing?: UsagePricing
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExecutionPolicyError(`Invalid model ${label}: expected an object`)
  return value as Record<string, unknown>
}

export function normalizeModelProtocol(value: unknown): ModelProtocol {
  if (value !== 'chat-completions' && value !== 'responses' && value !== 'anthropic') throw new ExecutionPolicyError('Invalid model protocol')
  return value
}

export function normalizeModelSettings(value: unknown): Record<string, ModelSettings> {
  const models = object(value, 'settings')
  if (Object.keys(models).length > 256) throw new ExecutionPolicyError('Model settings capacity exceeded')
  const entries = Object.entries(models).map(([model, input]) => {
    if (!model.trim() || Buffer.byteLength(model) > 4096) throw new ExecutionPolicyError('Invalid model identity')
    const raw = object(input, 'configuration')
    if (Object.keys(raw).some(key => !['protocol', 'capabilities', 'effort', 'pricing'].includes(key))) throw new ExecutionPolicyError('Invalid model configuration field')
    const result: ModelSettings = {}
    if (raw.protocol !== undefined) result.protocol = normalizeModelProtocol(raw.protocol)
    if (raw.capabilities !== undefined) {
      const capabilities = object(raw.capabilities, 'capabilities')
      const normalized: Partial<ModelCapabilities> = {}
      for (const [name, value] of Object.entries(capabilities)) {
        if (name === 'contextWindow' || name === 'maxOutputTokens') {
          if (!Number.isSafeInteger(value) || Number(value) < 1) throw new ExecutionPolicyError(`Invalid model ${name}`)
          normalized[name] = Number(value)
        } else if (name === 'vision' || name === 'tools' || name === 'reasoning' || name === 'structuredOutput') {
          if (typeof value !== 'boolean') throw new ExecutionPolicyError(`Invalid model ${name}`)
          normalized[name] = value
        } else throw new ExecutionPolicyError('Invalid model capability field')
      }
      result.capabilities = normalized
    }
    if (raw.effort !== undefined) {
      const effort = object(raw.effort, 'effort')
      if (!['reasoning_effort', 'reasoning.effort', 'output_config.effort', 'thinking.budget_tokens'].includes(String(effort.parameter)) || Object.keys(effort).some(key => !['parameter', 'values', 'thinking'].includes(key))) throw new ExecutionPolicyError('Invalid model effort parameter')
      const values = object(effort.values, 'effort values')
      if (!Object.keys(values).length) throw new ExecutionPolicyError('Invalid model effort values')
      for (const [level, value] of Object.entries(values)) {
        if (!isEffortLevel(level) || (effort.parameter === 'thinking.budget_tokens' ? !Number.isSafeInteger(value) || Number(value) < 1 : typeof value !== 'string' || !value.trim() || value.length > 128)) throw new ExecutionPolicyError('Invalid model effort value')
      }
      if (effort.thinking !== undefined && effort.thinking !== 'adaptive' && effort.thinking !== 'enabled') throw new ExecutionPolicyError('Invalid model thinking mode')
      result.effort = { parameter: effort.parameter as AdapterEffort['parameter'], values: { ...values }, ...(effort.thinking === undefined ? {} : { thinking: effort.thinking }) }
    }
    if (raw.pricing !== undefined) {
      const pricing = object(raw.pricing, 'pricing')
      if (typeof pricing.version !== 'string' || !pricing.version.trim() || pricing.version.length > 4096) throw new ExecutionPolicyError('Invalid model pricing version')
      for (const [name, value] of Object.entries(pricing)) {
        if (name === 'version') continue
        if (!['inputPer1M', 'outputPer1M', 'cachedInputPer1M', 'cacheWritePer1M'].includes(name) || typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new ExecutionPolicyError('Invalid model pricing rate')
      }
      if (typeof pricing.inputPer1M !== 'number' || typeof pricing.outputPer1M !== 'number') throw new ExecutionPolicyError('Invalid model pricing rates')
      result.pricing = { ...pricing } as unknown as UsagePricing
    }
    return [model, result] as const
  })
  return Object.fromEntries(entries)
}

export function mergeModelSettings(base?: Record<string, ModelSettings>, override?: Record<string, ModelSettings>): Record<string, ModelSettings> | undefined {
  if (!base && !override) return undefined
  const merged = Object.fromEntries(Object.entries(base ?? {}).map(([model, settings]) => [model, structuredClone(settings)]))
  for (const [model, settings] of Object.entries(override ?? {})) {
    const previous = Object.hasOwn(merged, model) ? merged[model] : undefined
    Object.defineProperty(merged, model, { enumerable: true, configurable: true, writable: true, value: { ...previous, ...structuredClone(settings), ...(previous?.capabilities || settings.capabilities ? { capabilities: { ...previous?.capabilities, ...settings.capabilities } } : {}) } })
  }
  return merged
}
