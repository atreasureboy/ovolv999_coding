import { mkdtempSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CostTracker } from '../../src/core/costTracker.js'
import type * as LedgerModule from '../../src/core/usageLedger.js'

const directories: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

async function ledgerModule() {
  const path = '../../src/core/usageLedger.js'
  const module = await import(path).catch(() => null)
  expect(module, 'The gateway needs one durable ledger for every request in a run family').not.toBeNull()
  return module as typeof LedgerModule
}

const pricing = { version: 'fixture-v1', inputPer1M: 2, cachedInputPer1M: 0.5, cacheWritePer1M: 3, outputPer1M: 10 }

it('counts parent, compaction, critic, reflection and child once in the same family', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: () => pricing })
  for (const [index, runId] of ['parent', 'parent', 'parent', 'parent', 'child'].entries()) {
    ledger.recordUsage({ requestId: `request-${index}`, runId, familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  }
  ledger.recordUsage({ requestId: 'request-4', runId: 'child', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  expect(ledger.summarizeUsage('family')).toMatchObject({ requestCount: 5, actualRequestCount: 5, inputTokens: 500, outputTokens: 50, unknownPriceRequestCount: 0 })
  expect(ledger.summarizeUsage('family', 'parent').requestCount).toBe(4)
  expect(ledger.summarizeUsage('family', 'child').requestCount).toBe(1)
})

it('keeps uncertain usage and unknown prices separate from known totals', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: model => model === 'fixture' ? pricing : null })
  ledger.recordUsage({ requestId: 'actual', runId: 'parent', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  ledger.recordUsage({ requestId: 'estimate', runId: 'parent', familyId: 'family', model: 'missing-price', kind: 'estimated', inputTokens: 20, outputTokens: 2 })
  ledger.recordUsage({ requestId: 'cancelled', runId: 'child', familyId: 'family', model: 'fixture', kind: 'unknown' })
  expect(ledger.summarizeUsage('family')).toMatchObject({ requestCount: 3, actualRequestCount: 1, estimatedRequestCount: 1, unknownRequestCount: 1, inputTokens: 120, outputTokens: 12, unknownPriceRequestCount: 2 })
})

it('prices cache reads and cache writes separately and never bills reasoning twice', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: () => pricing })
  ledger.recordUsage({ requestId: 'cache', runId: 'parent', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 1000, cachedInputTokens: 400, cacheWriteTokens: 100, outputTokens: 200, reasoningTokens: 150 })
  expect(ledger.summarizeUsage('family').knownCostUSD).toBeCloseTo(0.0035, 12)
  expect(ledger.records('family')[0].pricingVersion).toBe('fixture-v1')
  const missingRate = new UsageLedger({ pricing: () => ({ version: 'incomplete', inputPer1M: 2, outputPer1M: 10 }) })
  missingRate.recordUsage({ requestId: 'cache', runId: 'parent', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 1000, cachedInputTokens: 400, outputTokens: 200 })
  expect(missingRate.summarizeUsage('family').unknownPriceRequestCount).toBe(1)
})

it('preserves costs and request deduplication across restarts and detached snapshots', async () => {
  const { UsageLedger } = await ledgerModule()
  const root = mkdtempSync(join(tmpdir(), 'ovo-usage-ledger-'))
  directories.push(root)
  const record = { requestId: 'persisted', runId: 'parent', familyId: 'family', model: 'fixture', kind: 'actual' as const, inputTokens: 100, outputTokens: 10 }
  const first = new UsageLedger({ root, pricing: () => pricing })
  first.recordUsage(record)
  const second = new UsageLedger({ root, pricing: () => ({ ...pricing, version: 'changed', inputPer1M: 200 }) })
  second.recordUsage(record)
  expect(second.summarizeUsage('family')).toMatchObject({ requestCount: 1, knownCostUSD: 0.0003 })
  second.records('family')[0].inputTokens = 999
  record.inputTokens = 999
  expect(second.summarizeUsage('family').inputTokens).toBe(100)
  expect(() => second.recordUsage(record)).toThrow(/conflict/i)
})

it('rejects invalid and overlapping provider counters before accepting a receipt', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: () => pricing })
  const base = { requestId: 'invalid', runId: 'parent', familyId: 'family', model: 'fixture', kind: 'actual' as const, inputTokens: 100, outputTokens: 10 }
  for (const values of [{ inputTokens: -1 }, { inputTokens: NaN }, { inputTokens: 1.5 }, { cachedInputTokens: 101 }, { reasoningTokens: 11 }, { cachedInputTokens: 80, cacheWriteTokens: 30 }]) {
    expect(() => ledger.recordUsage({ ...base, ...values })).toThrow(/usage/i)
  }
  expect(ledger.summarizeUsage('family').requestCount).toBe(0)
})

it('renders gateway helper requests and uncertain usage from the same ledger', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: () => pricing })
  const tracker = new CostTracker(ledger)
  for (const requestId of ['main', 'compact', 'critic', 'reflection', 'child']) ledger.recordUsage({ requestId, runId: 'run', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  ledger.recordUsage({ requestId: 'uncertain', runId: 'run', familyId: 'family', model: 'fixture', kind: 'unknown' })
  expect(tracker.getTotalAPICalls()).toBe(6)
  expect(tracker.getTotalInputTokens()).toBe(500)
  expect(tracker.getTotalCost()).toBeCloseTo(0.0015, 12)
  expect(tracker.formatSummary()).toContain('5 actual, 0 estimated, 1 unknown')
  expect(tracker.formatSummary()).toContain('1 request with unknown cost')
})

it('resets the displayed cost scope without deleting durable request history', async () => {
  const { UsageLedger } = await ledgerModule()
  const ledger = new UsageLedger({ pricing: () => pricing })
  const tracker = new CostTracker(ledger)
  ledger.recordUsage({ requestId: 'old', runId: 'run', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  tracker.reset()
  ledger.recordUsage({ requestId: 'new', runId: 'run', familyId: 'family', model: 'fixture', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  expect(tracker.getTotalAPICalls()).toBe(1)
  expect(tracker.getModelUsage()[0].apiCalls).toBe(1)
  expect(ledger.records()).toHaveLength(2)
})

it('keeps an admitted request unknown across a crash and replaces it with one final receipt', async () => {
  const { UsageLedger } = await ledgerModule()
  const root = mkdtempSync(join(tmpdir(), 'ovo-usage-inflight-'))
  directories.push(root)
  const pending = { requestId: 'inflight', runId: 'run', familyId: 'family', model: 'fixture', kind: 'unknown' as const }
  new UsageLedger({ root, pricing: () => pricing }).beginUsage(pending)
  const recovered = new UsageLedger({ root, pricing: () => pricing })
  expect(recovered.summarizeUsage('family')).toMatchObject({ requestCount: 1, unknownRequestCount: 1, unknownPriceRequestCount: 1 })
  recovered.recordUsage({ ...pending, kind: 'actual', inputTokens: 100, outputTokens: 10 })
  expect(new UsageLedger({ root, pricing: () => pricing }).summarizeUsage('family')).toMatchObject({ requestCount: 1, actualRequestCount: 1, unknownRequestCount: 0, knownCostUSD: 0.0003 })
})

it.each(['completed', 'missing'])('handles a %s pending entry removed after enumeration', async outcome => {
  const { UsageLedger } = await ledgerModule()
  const root = mkdtempSync(join(tmpdir(), 'ovo-usage-race-'))
  directories.push(root)
  const record = { requestId: 'race', runId: 'run', familyId: 'family', model: 'fixture', kind: 'unknown' as const }
  const writer = new UsageLedger({ root, pricing: () => pricing })
  writer.beginUsage(record)
  const reader = new UsageLedger({ root, pricing: () => pricing })
  const readable = reader as unknown as { read(path: string, pending?: boolean): LedgerModule.UsageRecord }
  const original = readable.read.bind(reader)
  let interleaved = false
  vi.spyOn(readable, 'read').mockImplementation((path, pending) => {
    if (!interleaved && pending) {
      interleaved = true
      if (outcome === 'completed') writer.recordUsage({ ...record, kind: 'actual', inputTokens: 100, outputTokens: 10 })
      else unlinkSync(path)
    }
    return original(path, pending)
  })
  if (outcome === 'completed') {
    expect(reader.summarizeUsage('family')).toMatchObject({ requestCount: 1, actualRequestCount: 1, unknownRequestCount: 0 })
    expect(reader.summarizeUsage('family')).toMatchObject({ requestCount: 1, actualRequestCount: 1, unknownRequestCount: 0 })
  } else expect(() => reader.summarizeUsage('family')).toThrow()
  expect(interleaved).toBe(true)
})

it('refuses encoded receipts larger than its restart reader can accept', async () => {
  const { UsageLedger } = await ledgerModule()
  const root = mkdtempSync(join(tmpdir(), 'ovo-usage-size-'))
  directories.push(root)
  const oversized = '\0'.repeat(4090)
  const ledger = new UsageLedger({ root, pricing: () => ({ ...pricing, version: oversized }) })
  expect(() => ledger.recordUsage({ requestId: 'large', runId: 'run', familyId: 'family', model: oversized, kind: 'actual', inputTokens: 100, outputTokens: 10 })).toThrow(/receipt.*size/i)
  expect(new UsageLedger({ root }).records()).toEqual([])
})
