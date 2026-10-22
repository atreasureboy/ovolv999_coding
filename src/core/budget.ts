/**
 * Token Budget Management
 *
 * Set and enforce token/cost budgets per session or per task.
 * Provides warnings when approaching limits and hard stops when exceeded.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'path'
import { isRecord } from './persistedData.js'
import { acquirePersistenceLeaseSync, type PersistenceLease } from './persistenceLock.js'
import type { NormalizedUsage } from './model/types.js'
import type { UsagePricing } from './modelPricing.js'
import { OutcomeError } from './outcome.js'

// ── Types ───────────────────────────────────────────────────────────────────

export type BudgetType = 'tokens' | 'cost' | 'requests'

export type BudgetPeriod = 'session' | 'daily' | 'weekly' | 'monthly'

export interface BudgetConfig {
  /** Unique name */
  name: string
  /** What to limit */
  type: BudgetType
  /** Time period */
  period: BudgetPeriod
  /** Maximum allowed value */
  limit: number
  /** Whether the budget is enforced (hard stop) or just advisory */
  enforced: boolean
  /** Warning threshold (0-1, default 0.8) */
  warningThreshold: number
  /** Whether this budget is enabled */
  enabled: boolean
}

export interface BudgetUsage {
  /** Current spent amount */
  spent: number
  reserved?: number
  conservative?: number
  /** Budget limit */
  limit: number
  /** Usage ratio (0-1+) */
  ratio: number
  /** Remaining budget */
  remaining: number
  /** Whether limit is exceeded */
  exceeded: boolean
  /** Whether warning threshold is reached */
  warning: boolean
  /** Percentage used (0-100) */
  percent: number
}

export interface BudgetSnapshot {
  config: BudgetConfig
  usage: BudgetUsage
  /** Period start timestamp */
  periodStart: string
  /** Period end timestamp (when it resets) */
  periodEnd: string
  /** History of resets */
  lastReset: string | null
}

export interface BudgetStore {
  budgets: Record<string, BudgetConfig>
  /** Usage tracking: name → period key → amount */
  usage: Record<string, Record<string, number>>
  /** Reset timestamps */
  resets: Record<string, string>
  reservations?: Record<string, Array<{ name: string; periodKey: string; amount: number; type: BudgetType }>>
  conservative?: Record<string, Record<string, number>>
}

// ── Persistence ─────────────────────────────────────────────────────────────

export function getBudgetPath(cwd: string): string {
  return join(resolve(cwd), '.ovolv999', 'budgets.json')
}

function dictionary<T>(entries: Iterable<readonly [string, T]> = []): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, Object.fromEntries(entries))
}

function emptyStore(): BudgetStore {
  return { budgets: dictionary(), usage: dictionary(), resets: dictionary() }
}

export function loadBudgetStore(cwd: string, strict = false): BudgetStore {
  const path = getBudgetPath(cwd)
  if (!existsSync(path)) {
    return emptyStore()
  }
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(data)) throw new Error('Invalid budget store')
    if (strict && (!isRecord(data.budgets) || !isRecord(data.usage) || !isRecord(data.resets) || Object.entries(data.budgets).some(([name, config]) => !isBudgetConfig(config) || config.name !== name) || Object.values(data.usage).some(value => !isRecord(value) || Object.values(value).some(amount => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)))) throw new Error('Invalid budget store')
    const budgets = dictionary(Object.entries(isRecord(data.budgets) ? data.budgets : {}).filter(([name, value]) => isBudgetConfig(value) && value.name === name)) as Record<string, BudgetConfig>
    const usage = dictionary(Object.entries(isRecord(data.usage) ? data.usage : {}).filter(([, value]) => isRecord(value)).map(([name, value]) => [name, dictionary(Object.entries(value as Record<string, unknown>).filter(([, amount]) => typeof amount === 'number' && Number.isFinite(amount) && amount >= 0))])) as Record<string, Record<string, number>>
    const resets = dictionary(Object.entries(isRecord(data.resets) ? data.resets : {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    const reservations = dictionary<Array<{ name: string; periodKey: string; amount: number; type: BudgetType }>>()
    if (data.reservations !== undefined) {
      if (!isRecord(data.reservations)) throw new Error('Invalid budget reservations')
      for (const [id, entries] of Object.entries(data.reservations)) {
        if (!Array.isArray(entries) || entries.some(entry => !isRecord(entry) || typeof entry.name !== 'string' || typeof entry.periodKey !== 'string' || typeof entry.amount !== 'number' || !Number.isFinite(entry.amount) || entry.amount < 0 || !['tokens', 'cost', 'requests'].includes(String(entry.type)))) throw new Error('Invalid budget reservation')
        reservations[id] = entries as NonNullable<BudgetStore['reservations']>[string]
      }
    }
    const conservative = dictionary<Record<string, number>>()
    if (data.conservative !== undefined) {
      if (!isRecord(data.conservative)) throw new Error('Invalid conservative budget usage')
      for (const [name, periods] of Object.entries(data.conservative)) {
        if (!isRecord(periods) || Object.values(periods).some(amount => typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)) throw new Error('Invalid conservative budget usage')
        conservative[name] = dictionary(Object.entries(periods)) as Record<string, number>
      }
    }
    return { budgets, usage, resets, reservations, conservative }
  } catch (error) {
    if (strict) throw new OutcomeError('Project budget persistence is invalid; preserve it for recovery before making model requests', { code: 'recovery_required', scope: 'budget' }, { cause: error })
    return emptyStore()
  }
}

function isBudgetConfig(value: unknown): value is BudgetConfig {
  return isRecord(value) && typeof value.name === 'string' && !!value.name.trim() &&
    typeof value.type === 'string' && ['tokens', 'cost', 'requests'].includes(value.type) &&
    typeof value.period === 'string' && ['session', 'daily', 'weekly', 'monthly'].includes(value.period) &&
    typeof value.limit === 'number' && Number.isFinite(value.limit) && value.limit >= 0 &&
    typeof value.enforced === 'boolean' && typeof value.enabled === 'boolean' &&
    typeof value.warningThreshold === 'number' && Number.isFinite(value.warningThreshold) && value.warningThreshold >= 0 && value.warningThreshold <= 1
}

function writeStore(cwd: string, store: BudgetStore, lease: PersistenceLease): void {
  const dir = join(resolve(cwd), '.ovolv999')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  const target = getBudgetPath(cwd)
  const temporary = `${target}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try {
    try { writeFileSync(fd, JSON.stringify(store, null, 2), 'utf8'); fsyncSync(fd) } finally { closeSync(fd) }
    lease.assertOwned()
    renameSync(temporary, target)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}

function mutateStore<T>(cwd: string, mutate: (store: BudgetStore) => T): T {
  const lease = acquirePersistenceLeaseSync(getBudgetPath(cwd))
  try {
    const store = loadBudgetStore(cwd, true)
    const result = mutate(store)
    writeStore(cwd, store, lease)
    return result
  } finally { lease.release() }
}

export function saveBudgetStore(cwd: string, store: BudgetStore): void {
  const lease = acquirePersistenceLeaseSync(getBudgetPath(cwd))
  try { writeStore(cwd, store, lease) } finally { lease.release() }
}

// ── Period Helpers ──────────────────────────────────────────────────────────

export function getPeriodKey(period: BudgetPeriod, date = new Date()): string {
  switch (period) {
    case 'session':
      return 'session'
    case 'daily':
      return date.toISOString().slice(0, 10) // YYYY-MM-DD
    case 'weekly': {
      // Get ISO week
      const tmp = new Date(date)
      tmp.setUTCHours(0, 0, 0, 0)
      tmp.setUTCDate(tmp.getUTCDate() - ((tmp.getUTCDay() + 6) % 7))
      return tmp.toISOString().slice(0, 10)
    }
    case 'monthly':
      return date.toISOString().slice(0, 7) // YYYY-MM
  }
}

export function getPeriodStart(period: BudgetPeriod, date = new Date()): Date {
  const d = new Date(date)
  switch (period) {
    case 'session':
      return d
    case 'daily':
      d.setUTCHours(0, 0, 0, 0)
      return d
    case 'weekly': {
      d.setUTCHours(0, 0, 0, 0)
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
      return d
    }
    case 'monthly':
      d.setUTCDate(1)
      d.setUTCHours(0, 0, 0, 0)
      return d
  }
}

export function getPeriodEnd(period: BudgetPeriod, date = new Date()): Date {
  const start = getPeriodStart(period, date)
  switch (period) {
    case 'session':
      return new Date(8.64e15) // max date
    case 'daily':
      return new Date(start.getTime() + 24 * 60 * 60 * 1000)
    case 'weekly':
      return new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)
    case 'monthly':
      return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))
  }
}

// ── Budget CRUD ─────────────────────────────────────────────────────────────

export function setBudget(
  cwd: string,
  config: Omit<BudgetConfig, 'enabled' | 'enforced' | 'warningThreshold'> &
    Partial<Pick<BudgetConfig, 'enabled' | 'enforced' | 'warningThreshold'>>,
): BudgetConfig {
  const budget: BudgetConfig = {
    name: config.name,
    type: config.type,
    period: config.period,
    limit: config.limit,
    enforced: config.enforced ?? true,
    warningThreshold: config.warningThreshold ?? 0.8,
    enabled: config.enabled ?? true,
  }
  if (!isBudgetConfig(budget)) throw new Error('Invalid budget configuration')
  return mutateStore(cwd, store => {
    if (Object.values(store.reservations ?? {}).some(entries => entries.some(entry => entry.name === budget.name))) throw new Error('Cannot replace a budget with pending model reservations')
    store.budgets[budget.name] = budget
    return budget
  })
}

export function removeBudget(cwd: string, name: string): boolean {
  return mutateStore(cwd, store => {
    if (!store.budgets[name]) return false
    if (Object.values(store.reservations ?? {}).some(entries => entries.some(entry => entry.name === name))) throw new Error('Cannot remove a budget with pending model reservations')
    delete store.budgets[name]
    delete store.usage[name]
    delete store.resets[name]
    delete store.conservative?.[name]
    return true
  })
}

export function getBudget(cwd: string, name: string): BudgetConfig | null {
  const store = loadBudgetStore(cwd)
  return store.budgets[name] ?? null
}

export function listBudgets(cwd: string): BudgetConfig[] {
  const store = loadBudgetStore(cwd)
  return Object.values(store.budgets)
}

// ── Usage Tracking ──────────────────────────────────────────────────────────

export function recordUsage(
  cwd: string,
  budgetName: string,
  amount: number,
  date = new Date(),
): BudgetUsage | null {
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Budget usage amount must be finite and non-negative')
  const recorded = mutateStore(cwd, store => {
    const config = store.budgets[budgetName]
    if (!config || !config.enabled) return false
    const periodKey = getPeriodKey(config.period, date)
    if (!store.usage[budgetName]) store.usage[budgetName] = dictionary()
    const spent = (store.usage[budgetName][periodKey] ?? 0) + amount
    if (!Number.isFinite(spent)) throw new Error('Budget usage amount exceeds supported range')
    store.usage[budgetName][periodKey] = spent
    store.resets[budgetName] ??= new Date().toISOString()
    return true
  })
  return recorded ? getUsage(cwd, budgetName, date) : null
}

export function getUsage(
  cwd: string,
  budgetName: string,
  date = new Date(),
): BudgetUsage | null {
  const store = loadBudgetStore(cwd)
  const config = store.budgets[budgetName]
  if (!config) return null

  const periodKey = getPeriodKey(config.period, date)
  const spent = store.usage[budgetName]?.[periodKey] ?? 0
  const reserved = Object.values(store.reservations ?? {}).flat().filter(entry => entry.name === budgetName && entry.periodKey === periodKey).reduce((sum, entry) => sum + entry.amount, 0)
  const limit = config.limit
  const ratio = limit > 0 ? spent / limit : 0
  const remaining = Math.max(0, limit - spent)

  return {
    spent,
    reserved,
    conservative: store.conservative?.[budgetName]?.[periodKey] ?? 0,
    limit,
    ratio,
    remaining,
    exceeded: spent >= limit,
    warning: ratio >= config.warningThreshold && !exceededOrEqual(spent, limit),
    percent: Math.round(ratio * 100),
  }
}

function exceededOrEqual(spent: number, limit: number): boolean {
  return spent >= limit
}

export function checkBudget(
  cwd: string,
  budgetName: string,
  date = new Date(),
): { allowed: boolean; reason: string; usage: BudgetUsage | null } {
  const config = getBudget(cwd, budgetName)
  if (!config || !config.enabled) {
    return { allowed: true, reason: 'No active budget', usage: null }
  }

  const usage = getUsage(cwd, budgetName, date)
  if (!usage) {
    return { allowed: true, reason: 'Unable to read usage', usage: null }
  }

  if (usage.exceeded) {
    if (config.enforced) {
      return {
        allowed: false,
        reason: `${config.type} budget "${config.name}" exceeded: ${usage.spent}/${usage.limit} (${usage.percent}%)`,
        usage,
      }
    }
    return {
      allowed: true,
      reason: `⚠ WARNING: ${config.type} budget "${config.name}" exceeded: ${usage.spent}/${usage.limit} (${usage.percent}%) [advisory]`,
      usage,
    }
  }

  if (usage.warning) {
    return {
      allowed: true,
      reason: `⚠ WARNING: ${config.type} budget "${config.name}" at ${usage.percent}% (${usage.spent}/${usage.limit})`,
      usage,
    }
  }

  return {
    allowed: true,
    reason: `${usage.percent}% of "${config.name}" budget used`,
    usage,
  }
}

export function checkAllBudgets(
  cwd: string,
  date = new Date(),
): { allAllowed: boolean; results: Array<{ name: string; config: BudgetConfig; result: ReturnType<typeof checkBudget> }> } {
  const budgets = listBudgets(cwd)
  const results = budgets.map(config => ({
    name: config.name,
    config,
    result: checkBudget(cwd, config.name, date),
  }))
  return {
    allAllowed: results.every(r => r.result.allowed),
    results,
  }
}

export function resetUsage(cwd: string, budgetName: string): boolean {
  return mutateStore(cwd, store => {
    if (!store.budgets[budgetName]) return false
    if (Object.values(store.reservations ?? {}).some(entries => entries.some(entry => entry.name === budgetName))) throw new Error('Cannot reset a budget with pending model reservations; preserve usage for recovery')
    store.usage[budgetName] = dictionary()
    delete store.conservative?.[budgetName]
    store.resets[budgetName] = new Date().toISOString()
    return true
  })
}

export interface ModelBudgetReservation {
  settle(usage: NormalizedUsage, dispatched: boolean): void
}

function actualTokenTotal(usage: NormalizedUsage): number | undefined {
  if (usage.kind !== 'actual' || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined
  const counts = [usage.inputTokens, usage.outputTokens, usage.cachedInputTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.reasoningTokens ?? 0]
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return undefined
  const total = usage.inputTokens + usage.outputTokens
  if (!Number.isSafeInteger(total) || (usage.cachedInputTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > usage.inputTokens || (usage.reasoningTokens ?? 0) > usage.outputTokens) return undefined
  return total
}

function usageCost(usage: NormalizedUsage, pricing: UsagePricing | null): number | undefined {
  if (!pricing || usage.kind !== 'actual' || usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined
  const cached = usage.cachedInputTokens ?? 0
  const written = usage.cacheWriteTokens ?? 0
  if ((cached && pricing.cachedInputPer1M === undefined) || (written && pricing.cacheWritePer1M === undefined)) return undefined
  return ((usage.inputTokens - cached - written) * pricing.inputPer1M + cached * (pricing.cachedInputPer1M ?? 0) + written * (pricing.cacheWritePer1M ?? 0) + usage.outputTokens * pricing.outputPer1M) / 1_000_000
}

export function reserveModelBudget(cwd: string, requestId: string, contextWindow: number, outputTokens: number, pricing: UsagePricing | null): ModelBudgetReservation {
  const initial = loadBudgetStore(cwd, true)
  if (!Object.values(initial.budgets).some(config => config.enabled)) return { settle() {} }
  const tokenCapacity = contextWindow + outputTokens
  const rates = pricing ? [pricing.inputPer1M, pricing.outputPer1M, pricing.cachedInputPer1M ?? pricing.inputPer1M, pricing.cacheWritePer1M ?? pricing.inputPer1M] : []
  if (!Number.isSafeInteger(tokenCapacity) || tokenCapacity < 1 || rates.some(rate => !Number.isFinite(rate) || rate < 0)) throw new Error('Invalid project model budget reservation basis')
  const costCapacity = pricing ? tokenCapacity * Math.max(...rates) / 1_000_000 : undefined
  mutateStore(cwd, store => {
    if (Object.hasOwn(store.reservations ?? {}, requestId)) throw new Error('Duplicate project budget reservation identity')
    const entries: NonNullable<BudgetStore['reservations']>[string] = []
    for (const config of Object.values(store.budgets)) {
      if (!config.enabled) continue
      if (config.type === 'cost' && costCapacity === undefined && config.enforced) throw new OutcomeError(`Cost budget "${config.name}" requires known model pricing before a request can be sent`, { code: 'budget_denied', kind: 'pricing' })
      const amount = config.type === 'requests' ? 1 : config.type === 'tokens' ? tokenCapacity : costCapacity ?? config.limit
      const periodKey = getPeriodKey(config.period)
      const spent = store.usage[config.name]?.[periodKey] ?? 0
      if (!Number.isFinite(amount) || !Number.isFinite(spent + amount)) throw new Error('Project budget reservation exceeds supported range')
      if (config.enforced && (spent >= config.limit || spent + amount > config.limit)) throw new OutcomeError(`Project ${config.type} budget "${config.name}" cannot admit request: ${spent} spent/reserved + ${amount} required > ${config.limit}; token/cost reservation uses model context capacity ${contextWindow} + output cap ${outputTokens}, including unknown usage`, { code: 'budget_denied', kind: config.type })
      entries.push({ name: config.name, periodKey, amount, type: config.type })
    }
    for (const entry of entries) {
      store.usage[entry.name] ??= dictionary()
      store.usage[entry.name][entry.periodKey] = (store.usage[entry.name][entry.periodKey] ?? 0) + entry.amount
    }
    store.reservations ??= dictionary()
    store.reservations[requestId] = entries
  })
  let settled = false
  return {
    settle(usage, dispatched) {
      if (settled) return
      mutateStore(cwd, store => {
        const entries = store.reservations?.[requestId]
        if (!entries) throw new Error('Project budget reservation is missing; preserve usage for recovery')
        const actualTokens = actualTokenTotal(usage)
        const cost = actualTokens === undefined ? undefined : usageCost(usage, pricing)
        for (const entry of entries) {
          const amount = !dispatched ? 0 : entry.type === 'requests' ? 1 : entry.type === 'tokens' ? actualTokens ?? entry.amount : cost ?? entry.amount
          const spent = (store.usage[entry.name]?.[entry.periodKey] ?? 0) - entry.amount + amount
          if (!Number.isFinite(spent) || spent < 0) throw new Error('Invalid project budget settlement; preserve reservation for recovery')
          store.usage[entry.name][entry.periodKey] = spent
          if (dispatched && (entry.type === 'tokens' && actualTokens === undefined || entry.type === 'cost' && cost === undefined)) {
            store.conservative ??= dictionary()
            store.conservative[entry.name] ??= dictionary()
            store.conservative[entry.name][entry.periodKey] = (store.conservative[entry.name][entry.periodKey] ?? 0) + amount
          }
        }
        delete store.reservations![requestId]
      })
      settled = true
    },
  }
}

// ── Snapshots ───────────────────────────────────────────────────────────────

export function getBudgetSnapshot(
  cwd: string,
  budgetName: string,
  date = new Date(),
): BudgetSnapshot | null {
  const config = getBudget(cwd, budgetName)
  if (!config) return null

  const usage = getUsage(cwd, budgetName, date)
  if (!usage) return null

  const store = loadBudgetStore(cwd)

  return {
    config,
    usage,
    periodStart: getPeriodStart(config.period, date).toISOString(),
    periodEnd: getPeriodEnd(config.period, date).toISOString(),
    lastReset: store.resets[budgetName] ?? null,
  }
}

// ── Formatting ──────────────────────────────────────────────────────────────

function formatAmount(type: BudgetType, amount: number): string {
  switch (type) {
    case 'tokens':
      return amount >= 1000 ? `${(amount / 1000).toFixed(1)}K` : String(amount)
    case 'cost':
      return `$${amount.toFixed(4)}`
    case 'requests':
      return String(amount)
  }
}

export function formatBudgetUsage(
  config: BudgetConfig,
  usage: BudgetUsage,
): string {
  const bar = formatProgressBar(usage.ratio, 20)
  const status = usage.exceeded ? '✗ EXCEEDED'
    : usage.warning ? '⚠ WARNING'
    : '✓ OK'

  return [
    `${config.name} (${config.type}/${config.period})${config.enforced ? '' : ' [advisory]'}${config.enabled ? '' : ' [disabled]'}`,
    `  ${bar} ${usage.percent}%`,
    `  ${formatAmount(config.type, usage.spent)} / ${formatAmount(config.type, usage.limit)} (${formatAmount(config.type, usage.remaining)} remaining)`,
    `  Status: ${status}`,
    ...(usage.reserved ? [`  Includes ${formatAmount(config.type, usage.reserved)} reserved pending settlement; interrupted requests remain reserved for recovery.`] : []),
    ...(usage.conservative ? [`  Includes ${formatAmount(config.type, usage.conservative)} conservatively charged because actual usage or pricing was unavailable.`] : []),
  ].join('\n')
}

export function formatProgressBar(ratio: number, width = 20): string {
  const clamped = Math.min(1, Math.max(0, ratio))
  const filled = Math.round(clamped * width)
  const empty = width - filled

  if (ratio >= 1) return `[${'█'.repeat(width)}]` // fully red
  if (ratio >= 0.8) return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`

  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}]`
}

export function formatBudgetSnapshot(snapshot: BudgetSnapshot): string {
  const { config, usage, periodStart, periodEnd, lastReset } = snapshot
  const lines = [
    formatBudgetUsage(config, usage),
    `  Period: ${periodStart.slice(0, 10)} → ${periodEnd.slice(0, 10)}`,
  ]
  if (lastReset) lines.push(`  Last reset: ${lastReset.slice(0, 10)}`)
  return lines.join('\n')
}

export function formatBudgetSummary(cwd: string): string {
  const budgets = listBudgets(cwd)
  if (budgets.length === 0) return 'No budgets configured.'

  const lines: string[] = ['Budget Summary:', '']
  for (const config of budgets) {
    const usage = getUsage(cwd, config.name)
    if (!usage) continue
    lines.push(formatBudgetUsage(config, usage))
    lines.push('')
  }

  const { allAllowed, results } = checkAllBudgets(cwd)
  const exceeded = results.filter(r => r.result.usage?.exceeded).length
  const warning = results.filter(r => r.result.usage?.warning).length

  lines.push(
    `Total: ${budgets.length} budget(s) | ${exceeded} exceeded | ${warning} warning${allAllowed ? '' : ' | ⚠ BLOCKED'}`,
  )

  return lines.join('\n')
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const BUDGET_PRESETS = {
  conservative: [
    { name: 'daily-tokens', type: 'tokens', period: 'daily', limit: 50_000 },
    { name: 'daily-cost', type: 'cost', period: 'daily', limit: 1.0 },
  ],
  moderate: [
    { name: 'daily-tokens', type: 'tokens', period: 'daily', limit: 200_000 },
    { name: 'daily-cost', type: 'cost', period: 'daily', limit: 5.0 },
    { name: 'monthly-cost', type: 'cost', period: 'monthly', limit: 100.0 },
  ],
  heavy: [
    { name: 'daily-tokens', type: 'tokens', period: 'daily', limit: 1_000_000 },
    { name: 'daily-cost', type: 'cost', period: 'daily', limit: 25.0 },
    { name: 'monthly-cost', type: 'cost', period: 'monthly', limit: 500.0 },
  ],
} satisfies Record<string, Array<{ name: string; type: BudgetType; period: BudgetPeriod; limit: number }>>

export function applyPreset(cwd: string, presetName: keyof typeof BUDGET_PRESETS): BudgetConfig[] {
  const preset = BUDGET_PRESETS[presetName]
  if (!preset) throw new Error(`Unknown preset: ${presetName}`)
  return preset.map(p => setBudget(cwd, p))
}
