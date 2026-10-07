import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { NormalizedUsage } from './model/types.js'
import { usagePricing, type UsagePricing } from './modelPricing.js'

export interface UsageRecord extends NormalizedUsage {
  requestId: string
  runId: string
  familyId: string
  model: string
  ownerId?: string
  durationMs?: number
  costUSD?: number
  pricingVersion?: string
}

export interface UsageSummary {
  requestCount: number
  actualRequestCount: number
  estimatedRequestCount: number
  unknownRequestCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  knownCostUSD: number
  unknownPriceRequestCount: number
}

const counters = ['inputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens'] as const
const metadata = ['requestId', 'runId', 'familyId', 'model', 'ownerId', 'pricingVersion'] as const
const maximumRecords = 100_000
const maximumReceiptBytes = 32_768

function normalize(record: UsageRecord): UsageRecord {
  if (!record || !['actual', 'estimated', 'unknown'].includes(record.kind)) throw new Error('Invalid usage kind')
  const result: UsageRecord = { kind: record.kind, requestId: record.requestId, runId: record.runId, familyId: record.familyId, model: record.model }
  for (const name of metadata) {
    const value = record[name]
    if (value === undefined && (name === 'ownerId' || name === 'pricingVersion')) continue
    if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value, 'utf8') > 4096) throw new Error(`Invalid usage ${name}`)
    result[name] = value
  }
  for (const name of counters) {
    const value = record[name]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid usage ${name}`)
    result[name] = value
  }
  if ((record.cachedInputTokens ?? 0) + (record.cacheWriteTokens ?? 0) > (record.inputTokens ?? 0)) throw new Error('Invalid usage cache counters exceed total input')
  if ((record.reasoningTokens ?? 0) > (record.outputTokens ?? 0)) throw new Error('Invalid usage reasoning exceeds total output')
  for (const name of ['costUSD', 'durationMs'] as const) {
    const value = record[name]
    if (value === undefined) continue
    if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid usage ${name}`)
    result[name] = value
  }
  return result
}

function price(record: UsageRecord, pricing: UsagePricing | null): UsageRecord {
  if (record.costUSD !== undefined || !pricing) return record
  if (typeof pricing.version !== 'string' || !pricing.version.trim()) throw new Error('Invalid usage pricing version')
  for (const key of ['inputPer1M', 'outputPer1M', 'cachedInputPer1M', 'cacheWritePer1M'] as const) {
    if (pricing[key] !== undefined && (!Number.isFinite(pricing[key]) || pricing[key] < 0)) throw new Error('Invalid usage pricing rate')
  }
  record.pricingVersion = pricing.version
  if (record.kind === 'unknown' || record.inputTokens === undefined || record.outputTokens === undefined) return record
  const cached = record.cachedInputTokens ?? 0
  const written = record.cacheWriteTokens ?? 0
  if ((cached && pricing.cachedInputPer1M === undefined) || (written && pricing.cacheWritePer1M === undefined)) return record
  record.costUSD = ((record.inputTokens - cached - written) * pricing.inputPer1M + cached * (pricing.cachedInputPer1M ?? 0) + written * (pricing.cacheWritePer1M ?? 0) + record.outputTokens * pricing.outputPer1M) / 1_000_000
  return normalize(record)
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }
function sameUsage(a: UsageRecord, b: UsageRecord): boolean {
  const comparable = (record: UsageRecord) => { const usage = { ...record }; delete usage.costUSD; delete usage.pricingVersion; return JSON.stringify(usage) }
  return comparable(a) === comparable(b)
}
function sameIdentity(a: UsageRecord, b: UsageRecord): boolean {
  return ['requestId', 'runId', 'familyId', 'model', 'ownerId'].every(key => a[key as keyof UsageRecord] === b[key as keyof UsageRecord])
}

export class UsageLedger {
  private readonly receipts = new Map<string, UsageRecord>()
  private readonly inflight = new Map<string, UsageRecord>()
  private readonly root?: string
  private readonly pricing: (model: string) => UsagePricing | null

  constructor(options: { root?: string; pricing?: (model: string) => UsagePricing | null } = {}) {
    this.root = options.root ? resolve(options.root) : undefined
    this.pricing = options.pricing ?? usagePricing
  }

  private read(path: string, pending = false): UsageRecord {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumReceiptBytes) throw new Error('Usage receipt exceeds supported size or is not a regular file; preserve for recovery')
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion?: unknown; record?: UsageRecord }
    if (raw.schemaVersion !== 1 || !raw.record) throw new Error('Unsupported usage receipt; preserve for recovery')
    const record = normalize(raw.record)
    if (join(this.root!, digest(record.familyId), digest(record.requestId) + (pending ? '.pending.json' : '.json')) !== path) throw new Error('Usage receipt identity conflict')
    if (pending && (record.kind !== 'unknown' || record.costUSD !== undefined || counters.some(name => record[name] !== undefined))) throw new Error('Invalid inflight usage receipt')
    return record
  }

  private remember(record: UsageRecord): void {
    const previous = this.receipts.get(record.requestId)
    if (previous && !sameUsage(previous, record)) throw new Error('Usage request identity conflict')
    if (!previous && this.receipts.size >= maximumRecords) throw new Error('Usage receipt capacity exceeded')
    this.receipts.set(record.requestId, record)
    this.inflight.delete(record.requestId)
  }

  private refresh(familyId?: string): void {
    if (!this.root || !existsSync(this.root)) return
    const families = familyId ? [digest(familyId)] : readdirSync(this.root).filter(name => /^[a-f0-9]{64}$/.test(name))
    let count = 0
    for (const family of families) {
      const directory = join(this.root, family)
      if (!existsSync(directory)) continue
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid usage receipt directory; preserve for recovery')
      for (const name of readdirSync(directory)) {
        if (!/^[a-f0-9]{64}(\.pending)?\.json$/.test(name)) continue
        if (++count > maximumRecords) throw new Error('Usage receipt capacity exceeded')
        const pending = name.endsWith('.pending.json')
        let record: UsageRecord
        try { record = this.read(join(directory, name), pending) } catch (error) {
          if (!pending || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          try { record = this.read(join(directory, name.replace('.pending.json', '.json'))) } catch (recoveryError) {
            throw new Error('Usage pending and final receipts are unavailable; preserve for recovery', { cause: recoveryError })
          }
          this.remember(record)
          continue
        }
        if (!pending) this.remember(record)
        else {
          const previous = this.receipts.get(record.requestId) ?? this.inflight.get(record.requestId)
          if (previous && !sameIdentity(previous, record)) throw new Error('Usage request identity conflict')
          if (!this.receipts.has(record.requestId)) this.inflight.set(record.requestId, record)
        }
      }
    }
  }

  private publish(record: UsageRecord, pending = false): UsageRecord {
    const serialized = JSON.stringify({ schemaVersion: 1, record })
    if (Buffer.byteLength(serialized, 'utf8') > maximumReceiptBytes) throw new Error('Usage receipt exceeds supported size')
    if (!this.root) return record
    const directory = join(this.root, digest(record.familyId))
    mkdirSync(directory, { recursive: true })
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Invalid usage receipt directory')
    const path = join(directory, digest(record.requestId) + (pending ? '.pending.json' : '.json'))
    const temporary = path + '.' + randomUUID() + '.tmp'
    const fd = openSync(temporary, 'wx', 0o600)
    try {
      try { writeFileSync(fd, serialized); fsyncSync(fd) } finally { closeSync(fd) }
      try { linkSync(temporary, path) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const previous = this.read(path, pending)
        if (!(pending ? sameIdentity(previous, record) : sameUsage(previous, record))) throw new Error('Usage request identity conflict', { cause: error })
        return previous
      }
      if (process.platform !== 'win32') {
        const directoryFd = openSync(directory, 'r')
        try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
      }
      return record
    } finally { unlinkSync(temporary) }
  }

  beginUsage(input: UsageRecord): void {
    const normalized = normalize(input)
    const record: UsageRecord = { requestId: normalized.requestId, runId: normalized.runId, familyId: normalized.familyId, model: normalized.model, ...(normalized.ownerId ? { ownerId: normalized.ownerId } : {}), kind: 'unknown' }
    this.refresh()
    const existing = this.receipts.get(record.requestId) ?? this.inflight.get(record.requestId)
    if (existing) {
      if (!sameIdentity(existing, record)) throw new Error('Usage request identity conflict')
      return
    }
    if (this.receipts.size + this.inflight.size >= maximumRecords) throw new Error('Usage receipt capacity exceeded')
    this.inflight.set(record.requestId, this.publish(record, true))
  }

  recordUsage(input: UsageRecord): void {
    const normalized = normalize(input)
    this.refresh()
    const existing = this.receipts.get(normalized.requestId)
    if (existing) {
      if (!sameUsage(existing, normalized)) throw new Error('Usage request identity conflict')
      return
    }
    const pending = this.inflight.get(normalized.requestId)
    if (pending && !sameIdentity(pending, normalized)) throw new Error('Usage request identity conflict')
    if (!pending && this.receipts.size + this.inflight.size >= maximumRecords) throw new Error('Usage receipt capacity exceeded')
    const record = this.publish(price(normalized, this.pricing(normalized.model)))
    this.remember(record)
    if (this.root) {
      const pendingPath = join(this.root, digest(record.familyId), digest(record.requestId) + '.pending.json')
      try { unlinkSync(pendingPath) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
  }

  records(familyId?: string, runId?: string, ownerId?: string): UsageRecord[] {
    this.refresh(familyId)
    return [...this.receipts.values(), ...this.inflight.values()].filter(record => (!familyId || record.familyId === familyId) && (!runId || record.runId === runId) && (!ownerId || record.ownerId === ownerId)).map(record => ({ ...record }))
  }

  summarizeUsage(familyId?: string, runId?: string, ownerId?: string, excluded?: ReadonlySet<string>): UsageSummary {
    const result: UsageSummary = { requestCount: 0, actualRequestCount: 0, estimatedRequestCount: 0, unknownRequestCount: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, knownCostUSD: 0, unknownPriceRequestCount: 0 }
    for (const record of this.records(familyId, runId, ownerId)) {
      if (excluded?.has(record.requestId)) continue
      result.requestCount++
      if (record.kind === 'actual') result.actualRequestCount++
      else if (record.kind === 'estimated') result.estimatedRequestCount++
      else result.unknownRequestCount++
      if (record.kind !== 'unknown') for (const name of counters) result[name] += record[name] ?? 0
      if (record.costUSD === undefined) result.unknownPriceRequestCount++
      else result.knownCostUSD += record.costUSD
    }
    return result
  }
}

const defaultLedger = new UsageLedger()
export function recordUsage(record: UsageRecord): void { defaultLedger.recordUsage(record) }
export function summarizeUsage(familyId: string): UsageSummary { return defaultLedger.summarizeUsage(familyId) }
