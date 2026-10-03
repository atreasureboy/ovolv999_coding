import { describe, expect, it } from 'vitest'
import { calculateUSDCost, CostTracker, getModelPricing } from '../../src/core/costTracker.js'

describe('unknown model pricing', () => {
  it.each(['constructor', '__proto__', 'toString'])('keeps usage finite for %s', (model) => {
    expect(getModelPricing(model)).toBeNull()
    const usage = { inputTokens: 12, outputTokens: 4 }
    expect(calculateUSDCost(model, usage)).toBe(0)
    const tracker = new CostTracker()
    tracker.addUsage(model, usage)
    expect(tracker.hasUnknownModel()).toBe(true)
    expect(tracker.getTotalCost()).toBe(0)
    expect(tracker.getModelUsage()).toEqual([{ model, ...usage, costUSD: 0, apiCalls: 1 }])
  })
})
