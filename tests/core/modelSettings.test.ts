import { expect, it } from 'vitest'
import { normalizeSettings } from '../../src/config/settings/normalization.js'
import { mergeSettingsLayers } from '../../src/config/settings/merge.js'

it('preserves explicit provider protocol, capability and effort mappings through settings layers', () => {
  const base = normalizeSettings({ modelSettings: { native: { protocol: 'responses', capabilities: { reasoning: true, tools: true, contextWindow: 64000 }, effort: { parameter: 'reasoning.effort', values: { medium: 'medium', high: 'high' } } } } })
  const project = normalizeSettings({ modelSettings: { native: { capabilities: { vision: true } } } })
  expect(mergeSettingsLayers(base, project).modelSettings?.native).toEqual({ protocol: 'responses', capabilities: { reasoning: true, tools: true, contextWindow: 64000, vision: true }, effort: { parameter: 'reasoning.effort', values: { medium: 'medium', high: 'high' } } })
})

it('rejects unsupported protocol and malformed capabilities instead of silently falling back', () => {
  for (const config of [{ protocol: 'unknown' }, { capabilities: { tools: 'yes' } }, { capabilities: { contextWindow: -1 } }, { capabilities: { madeUp: true } }, { effort: { parameter: 'reasoning.effort', values: { extreme: 'extreme' } } }]) expect(() => normalizeSettings({ modelSettings: { native: config } })).toThrow(/model/i)
})

it('preserves a versioned price override and rejects invalid rates', () => {
  const pricing = { version: 'local-contract-2026-10-04', inputPer1M: 2, cachedInputPer1M: 0.5, outputPer1M: 10 }
  expect(normalizeSettings({ modelSettings: { native: { pricing } } }).modelSettings?.native.pricing).toEqual(pricing)
  for (const invalid of [{ ...pricing, inputPer1M: -1 }, { ...pricing, version: '' }, { inputPer1M: 1, outputPer1M: 2 }]) expect(() => normalizeSettings({ modelSettings: { native: { pricing: invalid } } })).toThrow(/model/i)
})
