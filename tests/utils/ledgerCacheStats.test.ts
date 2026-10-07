import { expect, it } from 'vitest'
import { UsageLedger } from '../../src/core/usageLedger.js'
import * as cache from '../../src/utils/cacheStats.js'

it('uses settled provider receipts and keeps missing cache measurements unknown', () => {
  const ledger = new UsageLedger()
  for (const record of [{ requestId: 'hit', kind: 'actual' as const, inputTokens: 100, outputTokens: 10, cachedInputTokens: 50 }, { requestId: 'miss', kind: 'actual' as const, inputTokens: 100, outputTokens: 10, cachedInputTokens: 0 }, { requestId: 'unmeasured', kind: 'actual' as const, inputTokens: 100, outputTokens: 10 }, { requestId: 'cancelled', kind: 'unknown' as const }]) ledger.recordUsage({ ...record, familyId: 'family', runId: 'run', model: 'fixture' })
  const projection = (cache as typeof cache & { getLedgerCacheStats?: (ledger: UsageLedger) => cache.CacheStats & { unknownCacheRequests: number } }).getLedgerCacheStats
  expect(projection, 'Cache display must consume the gateway ledger').toBeTypeOf('function')
  const stats = projection(ledger)
  expect(stats).toMatchObject({ totalRequests: 4, cacheHits: 1, cacheMisses: 1, unknownCacheRequests: 2, totalCacheReadTokens: 50, hitRate: 0.5 })
  expect(cache.formatCacheStats(stats)).toContain('unknown')
})
