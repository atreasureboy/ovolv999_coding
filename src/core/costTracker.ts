import { getModelPricing, type ModelPricing } from './modelPricing.js'
import type { UsageLedger, UsageSummary } from './usageLedger.js'
export { getModelPricing } from './modelPricing.js'
export type { ModelPricing } from './modelPricing.js'

// ── Usage & cost types ──────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface ModelUsage {
  model: string
  inputTokens: number
  outputTokens: number
  costUSD: number
  apiCalls: number
}

/**
 * Compute USD cost for a single API call.
 * Returns 0 if pricing is unavailable. NOTE: this function is intentionally
 * side-effect-free — the unknown-model signal is tracked per CostTracker
 * instance via `CostTracker.addUsage()` + `hasUnknownModel()`, so concurrent
 * sessions cannot pollute one another's cost summary.
 */
export function calculateUSDCost(model: string, usage: TokenUsage): number {
  const pricing = getModelPricing(model)
  return pricing ? priceUsage(pricing, usage) : 0
}

function priceUsage(pricing: ModelPricing, usage: TokenUsage): number {
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPer1M +
    (usage.outputTokens / 1_000_000) * pricing.outputPer1M
  )
}

// ── Formatting helpers (ported from Claude Code) ────────────────────────────

/**
 * Format USD cost with smart decimal places.
 * Large costs → 2 decimals; small costs → 4 decimals (micro-billing accuracy).
 */
export function formatCost(cost: number, maxDecimalPlaces = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

export function formatTrackedCost(tracker: Pick<CostTracker, 'getTotalCost'> & Partial<Pick<CostTracker, 'getUsageSummary' | 'hasUnknownModel'>>): string {
  const total = tracker.getTotalCost()
  const unknown = tracker.getUsageSummary?.()?.unknownPriceRequestCount ?? (tracker.hasUnknownModel?.() ? 1 : 0)
  if (!unknown) return formatCost(total)
  const label = `${unknown} request${unknown === 1 ? '' : 's'} cost unknown`
  return total > 0 ? `${formatCost(total)} known; ${label}` : label
}

/** Format an integer with thousands separators. */
export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

/** Format milliseconds as a human-readable duration (e.g. "1.2s", "2m 13s"). */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  return `${m}m ${rs}s`
}

function round(n: number, precision: number): number {
  return Math.round(n * precision) / precision
}

// ── CostTracker ─────────────────────────────────────────────────────────────

/**
 * Accumulates API token usage and cost across a session.
 *
 * Usage:
 *   const tracker = new CostTracker()
 *   tracker.addUsage('gpt-4o', { inputTokens: 1200, outputTokens: 800 })
 *   console.log(tracker.formatSummary())
 */
export class CostTracker {
  private readonly excludedRequests = new Set<string>()
  constructor(private readonly ledger?: UsageLedger, private readonly ownerId?: string) {}

  getUsageSummary(): UsageSummary | null {
    return this.ledger?.summarizeUsage(undefined, undefined, this.ownerId, this.excludedRequests) ?? null
  }
  private totalCostUSD = 0
  private totalInputTokens = 0
  private totalOutputTokens = 0
  private totalAPICalls = 0
  private totalAPIDurationMs = 0
  private modelUsage = new Map<string, ModelUsage>()
  /** Per-instance unknown-model flag (not global) */
  private _hasUnknownModel = false

  /** Record usage from a single API call. */
  addUsage(model: string, usage: TokenUsage, durationMs?: number): void {
    const pricing = getModelPricing(model)
    const cost = pricing ? priceUsage(pricing, usage) : 0
    if (!pricing) this._hasUnknownModel = true
    this.totalCostUSD += cost
    this.totalInputTokens += usage.inputTokens
    this.totalOutputTokens += usage.outputTokens
    this.totalAPICalls++
    if (durationMs !== undefined) this.totalAPIDurationMs += durationMs

    const existing = this.modelUsage.get(model)
    if (existing) {
      existing.inputTokens += usage.inputTokens
      existing.outputTokens += usage.outputTokens
      existing.costUSD += cost
      existing.apiCalls++
    } else {
      this.modelUsage.set(model, {
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUSD: cost,
        apiCalls: 1,
      })
    }
  }

  getTotalCost(): number {
    if (this.ledger) return this.getUsageSummary()!.knownCostUSD
    return this.totalCostUSD
  }
  getTotalInputTokens(): number {
    if (this.ledger) return this.getUsageSummary()!.inputTokens
    return this.totalInputTokens
  }
  getTotalOutputTokens(): number {
    if (this.ledger) return this.getUsageSummary()!.outputTokens
    return this.totalOutputTokens
  }
  getTotalAPICalls(): number {
    if (this.ledger) return this.getUsageSummary()!.requestCount
    return this.totalAPICalls
  }
  getTotalAPIDurationMs(): number {
    if (this.ledger) return this.ledger.records(undefined, undefined, this.ownerId).filter(record => !this.excludedRequests.has(record.requestId)).reduce((sum, record) => sum + (record.durationMs ?? 0), 0)
    return this.totalAPIDurationMs
  }
  /** Whether any unknown model was encountered (costs may be inaccurate) */
  hasUnknownModel(): boolean {
    if (this.ledger) return this.getUsageSummary()!.unknownPriceRequestCount > 0
    return this._hasUnknownModel
  }
  getModelUsage(): ModelUsage[] {
    if (this.ledger) {
      const models = new Map<string, ModelUsage>()
      for (const record of this.ledger.records(undefined, undefined, this.ownerId)) {
        if (this.excludedRequests.has(record.requestId)) continue
        const usage = models.get(record.model) ?? { model: record.model, inputTokens: 0, outputTokens: 0, costUSD: 0, apiCalls: 0 }
        if (record.kind !== 'unknown') { usage.inputTokens += record.inputTokens ?? 0; usage.outputTokens += record.outputTokens ?? 0 }
        usage.costUSD += record.costUSD ?? 0
        usage.apiCalls++
        models.set(record.model, usage)
      }
      return [...models.values()]
    }
    return [...this.modelUsage.values()]
  }

  /** Reset all accumulated state (for tests / new sessions). */
  reset(): void {
    if (this.ledger) for (const record of this.ledger.records(undefined, undefined, this.ownerId)) this.excludedRequests.add(record.requestId)
    this.totalCostUSD = 0
    this.totalInputTokens = 0
    this.totalOutputTokens = 0
    this.totalAPICalls = 0
    this.totalAPIDurationMs = 0
    this.modelUsage.clear()
    this._hasUnknownModel = false
  }

  /**
   * Format a multi-line cost summary for end-of-turn / end-of-session display.
   * Modeled on Claude Code's formatTotalCost().
   */
  formatSummary(): string {
    if (this.ledger) {
      const summary = this.getUsageSummary()!
      return [
        `Known cost:           ${formatCost(summary.knownCostUSD)}${summary.unknownPriceRequestCount ? `; ${summary.unknownPriceRequestCount} request${summary.unknownPriceRequestCount === 1 ? '' : 's'} with unknown cost` : ''}`,
        `Total tokens:         ${formatNumber(summary.inputTokens)} input, ${formatNumber(summary.outputTokens)} output`,
        `Cache tokens:         ${formatNumber(summary.cachedInputTokens)} read, ${formatNumber(summary.cacheWriteTokens)} written`,
        `Reasoning tokens:     ${formatNumber(summary.reasoningTokens)} (included in output)`,
        `Total API calls:      ${summary.requestCount} (${summary.actualRequestCount} actual, ${summary.estimatedRequestCount} estimated, ${summary.unknownRequestCount} unknown)`,
      ].join('\n')
    }
    const costDisplay =
      formatCost(this.totalCostUSD) +
      (this._hasUnknownModel ? ' (costs may be inaccurate — unknown model pricing)' : '')

    const lines: string[] = [
      `Total cost:           ${costDisplay}`,
      `Total tokens:         ${formatNumber(this.totalInputTokens)} input, ${formatNumber(this.totalOutputTokens)} output`,
      `Total API calls:      ${this.totalAPICalls}`,
    ]

    if (this.totalAPIDurationMs > 0) {
      lines.push(`Total API duration:   ${formatDuration(this.totalAPIDurationMs)}`)
    }

    const usage = this.getModelUsage()
    if (usage.length > 0) {
      lines.push('Usage by model:')
      for (const u of usage) {
        lines.push(
          `  ${u.model}: ${formatNumber(u.inputTokens)} in, ${formatNumber(u.outputTokens)} out, ${u.apiCalls} call${u.apiCalls === 1 ? '' : 's'} (${formatCost(u.costUSD)})`,
        )
      }
    }

    return lines.join('\n')
  }
}

// ── File-type-aware token estimation (ported from Claude Code) ──────────────

/**
 * Estimate token count from raw text.
 * Default ratio: 4 bytes/token (matching OpenAI's rough guidance).
 */
export function roughTokenCountEstimation(content: string, bytesPerToken = 4): number {
  return Math.round(content.length / bytesPerToken)
}

/**
 * Returns estimated bytes-per-token ratio for a file extension.
 * Dense JSON has many single-character tokens ({, }, :, ,, ") making the
 * real ratio closer to 2 rather than 4.
 *
 * Ported from Claude Code's bytesPerTokenForFileType().
 */
export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension.toLowerCase()) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

/**
 * Like roughTokenCountEstimation but uses a more accurate bytes-per-token
 * ratio when the file type is known. Matters when falling back to estimates
 * for large tool results — an underestimate can let oversized content slip in.
 */
export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(content, bytesPerTokenForFileType(fileExtension))
}
