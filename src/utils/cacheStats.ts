/**
 * Cache Stats — prompt cache hit-rate tracking
 *
 * Tracks cache hit/miss for prompt caching across providers.
 * Warns when cache hit-rate drops below threshold.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { UsageLedger } from '../core/usageLedger.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface CacheEntry {
  timestamp: string
  model: string
  cacheHit: boolean
  cacheReadTokens: number
  cacheWriteTokens: number
  inputTokens: number
  outputTokens: number
  costSaved: number
}

export interface CacheStats {
  unknownCacheRequests?: number
  costSavingsKnown?: boolean
  totalRequests: number
  cacheHits: number
  cacheMisses: number
  hitRate: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCostSaved: number
  byModel: Record<string, ModelCacheStats>
  recentEntries: CacheEntry[]
}

const ledgerResets = new WeakMap<UsageLedger, Set<string>>()

export function resetLedgerCacheStats(ledger: UsageLedger): void {
  ledgerResets.set(ledger, new Set(ledger.records().map(record => record.requestId)))
}

export function getLedgerCacheStats(ledger: UsageLedger): CacheStats {
  const stats: CacheStats = { totalRequests: 0, cacheHits: 0, cacheMisses: 0, unknownCacheRequests: 0, hitRate: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalCostSaved: 0, costSavingsKnown: false, byModel: Object.create(null) as Record<string, ModelCacheStats>, recentEntries: [] }
  for (const record of ledger.records()) {
    if (ledgerResets.get(ledger)?.has(record.requestId)) continue
    stats.totalRequests++
    const model = stats.byModel[record.model] ?? { requests: 0, hits: 0, misses: 0, hitRate: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costSaved: 0 }
    model.requests++
    if (record.kind !== 'actual' || record.cachedInputTokens === undefined) stats.unknownCacheRequests!++
    else {
      if (record.cachedInputTokens > 0) { stats.cacheHits++; model.hits++ } else { stats.cacheMisses++; model.misses++ }
      stats.totalCacheReadTokens += record.cachedInputTokens
      model.cacheReadTokens += record.cachedInputTokens
    }
    if (record.kind === 'actual') { stats.totalCacheWriteTokens += record.cacheWriteTokens ?? 0; model.cacheWriteTokens += record.cacheWriteTokens ?? 0 }
    model.hitRate = model.hits + model.misses ? model.hits / (model.hits + model.misses) : 0
    stats.byModel[record.model] = model
  }
  stats.hitRate = stats.cacheHits + stats.cacheMisses ? stats.cacheHits / (stats.cacheHits + stats.cacheMisses) : 0
  return stats
}

export interface ModelCacheStats {
  requests: number
  hits: number
  misses: number
  hitRate: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costSaved: number
}

// ── Storage ─────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 1000
let entries: CacheEntry[] = []
let initialized = false

function getCachePath(): string {
  return join(homedir(), '.ovolv999', 'cache-stats.json')
}

function loadEntries(): void {
  if (initialized) return
  initialized = true
  const path = getCachePath()
  if (!existsSync(path)) return
  try {
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'))
    entries = Array.isArray(stored) ? stored.filter((entry: unknown): entry is CacheEntry =>
      entry !== null && typeof entry === 'object' && 'timestamp' in entry && typeof entry.timestamp === 'string' &&
      'model' in entry && typeof entry.model === 'string' && 'cacheHit' in entry && typeof entry.cacheHit === 'boolean' &&
      ['cacheReadTokens', 'cacheWriteTokens', 'inputTokens', 'outputTokens', 'costSaved'].every(field => Number.isFinite((entry as Record<string, unknown>)[field])),
    ).slice(-MAX_ENTRIES) : []
  } catch {
    entries = []
  }
}

function saveEntries(): void {
  const path = getCachePath()
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(entries, null, 2))
}

export function resetCacheStats(): void {
  entries = []
  initialized = true
  saveEntries()
}

// ── Recording ───────────────────────────────────────────────────────────────

export function recordCacheEntry(
  model: string,
  cacheHit: boolean,
  usage: {
    cacheReadTokens?: number
    cacheWriteTokens?: number
    inputTokens: number
    outputTokens: number
  },
  costSaved = 0,
): CacheEntry {
  loadEntries()

  const entry: CacheEntry = {
    timestamp: new Date().toISOString(),
    model,
    cacheHit,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costSaved,
  }

  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries = entries.slice(-MAX_ENTRIES)
  }
  saveEntries()

  return entry
}

// ── Stats Calculation ───────────────────────────────────────────────────────

export function getCacheStats(timeWindowMs?: number): CacheStats {
  loadEntries()

  let relevant = entries
  if (timeWindowMs) {
    const cutoff = Date.now() - timeWindowMs
    relevant = entries.filter(e => new Date(e.timestamp).getTime() >= cutoff)
  }

  const byModel: Record<string, ModelCacheStats> = Object.create(null) as Record<string, ModelCacheStats>
  let totalRequests = 0
  let cacheHits = 0
  let cacheMisses = 0
  let totalCacheReadTokens = 0
  let totalCacheWriteTokens = 0
  let totalCostSaved = 0

  for (const entry of relevant) {
    totalRequests++
    if (entry.cacheHit) cacheHits++
    else cacheMisses++

    totalCacheReadTokens += entry.cacheReadTokens
    totalCacheWriteTokens += entry.cacheWriteTokens
    totalCostSaved += entry.costSaved

    if (!byModel[entry.model]) {
      byModel[entry.model] = {
        requests: 0, hits: 0, misses: 0, hitRate: 0,
        cacheReadTokens: 0, cacheWriteTokens: 0, costSaved: 0,
      }
    }

    const modelStats = byModel[entry.model]
    modelStats.requests++
    if (entry.cacheHit) modelStats.hits++
    else modelStats.misses++
    modelStats.cacheReadTokens += entry.cacheReadTokens
    modelStats.cacheWriteTokens += entry.cacheWriteTokens
    modelStats.costSaved += entry.costSaved
  }

  for (const model of Object.keys(byModel)) {
    const ms = byModel[model]
    ms.hitRate = ms.requests > 0 ? ms.hits / ms.requests : 0
  }

  return {
    totalRequests,
    cacheHits,
    cacheMisses,
    hitRate: totalRequests > 0 ? cacheHits / totalRequests : 0,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalCostSaved,
    byModel,
    recentEntries: relevant.slice(-20).reverse(),
  }
}

// ── Warnings ────────────────────────────────────────────────────────────────

export interface CacheWarning {
  level: 'info' | 'warning' | 'critical'
  message: string
  suggestions: string[]
}

export function checkCacheHealth(minHitRate = 0.3): CacheWarning | null {
  const stats = getCacheStats(60 * 60 * 1000) // last hour

  if (stats.totalRequests < 10) return null

  if (stats.hitRate < minHitRate) {
    const suggestions: string[] = []
    if (stats.hitRate < 0.1) {
      suggestions.push('Check if prompt prefix is changing between turns (system prompt should be stable)')
      suggestions.push('Verify the provider supports prompt caching')
    } else {
      suggestions.push('Try to keep the conversation context stable')
      suggestions.push('Avoid frequent system prompt changes')
    }

    return {
      level: stats.hitRate < 0.1 ? 'critical' : 'warning',
      message: `Cache hit-rate is ${(stats.hitRate * 100).toFixed(1)}% (target: >${(minHitRate * 100).toFixed(0)}%)`,
      suggestions,
    }
  }

  return null
}

// ── Cost Savings ────────────────────────────────────────────────────────────

export function estimateCostSavings(
  cacheReadTokens: number,
  cacheWriteTokens: number,
  inputPricePer1M: number,
  cacheReadPricePer1M: number,
  cacheWritePricePer1M: number,
): number {
  const inputCost = (cacheReadTokens / 1_000_000) * inputPricePer1M
  const cacheReadCost = (cacheReadTokens / 1_000_000) * cacheReadPricePer1M
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * cacheWritePricePer1M
  return inputCost - cacheReadCost - cacheWriteCost
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatCacheStats(stats: CacheStats): string {
  const lines: string[] = [
    'Cache Stats:',
    `  Requests: ${stats.totalRequests} (${stats.cacheHits} hits, ${stats.cacheMisses} misses${stats.unknownCacheRequests ? `, ${stats.unknownCacheRequests} unknown` : ''})`,
    `  Hit rate: ${(stats.hitRate * 100).toFixed(1)}%`,
    `  Cache read: ${stats.totalCacheReadTokens.toLocaleString()} tokens`,
    `  Cache write: ${stats.totalCacheWriteTokens.toLocaleString()} tokens`,
    `  Cost saved: ${stats.costSavingsKnown === false ? 'unknown' : `$${stats.totalCostSaved.toFixed(4)}`}`,
  ]

  const modelNames = Object.keys(stats.byModel)
  if (modelNames.length > 1) {
    lines.push('')
    lines.push('By model:')
    for (const model of modelNames) {
      const ms = stats.byModel[model]
      lines.push(`  ${model}: ${(ms.hitRate * 100).toFixed(1)}% hit (${ms.hits}/${ms.requests})`)
    }
  }

  return lines.join('\n')
}

export function formatCacheWarning(warning: CacheWarning): string {
  const icon = warning.level === 'critical' ? '⚠⚠' : warning.level === 'warning' ? '⚠' : 'ℹ'
  const lines = [`${icon} ${warning.message}`]
  if (warning.suggestions.length > 0) {
    lines.push('Suggestions:')
    for (const s of warning.suggestions) lines.push(`  - ${s}`)
  }
  return lines.join('\n')
}
