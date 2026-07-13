/**
 * EventLog — 不可变事件流，记录任务的完整审计轨迹
 *
 * 每条事件为 NDJSON 格式，追加写入 session 目录下的 events.ndjson。
 * 支持按类型/标签查询，供 critic 检查、上下文压缩、agent 回调等系统使用。
 *
 * Robustness contract:
 *   - append() is best-effort: any I/O failure is swallowed so the engine
 *     never crashes because the audit log is unwritable.
 *   - readAll() is line-tolerant: a single corrupted line does NOT drop the
 *     rest of the log. Each line is parsed independently; malformed lines
 *     (bad JSON or wrong shape) are skipped, and a readAll() with options
 *     { onSkip } receives the count of dropped lines for diagnostics.
 *   - query() exposes a lightweight predicate filter for common lookups.
 *
 * NOTE: This module does NOT promise power-loss durability. `appendFileSync`
 * flushes to the OS but does not fsync the disk; a crash between the OS
 * flush and a hardware commit can still lose the last entry or two. Callers
 * that need stronger guarantees should add an explicit fsync layer.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export type EventType =
  | 'tool_call'
  | 'tool_result'
  | 'boot_context'
  | 'invoke_sent'
  | 'invoke_completed'
  | 'memory_write'
  | 'context_compact'
  | 'module_flag'
  | 'user_input'
  | 'user_interrupt'

/** Runtime whitelist — used by isValidEntry to reject unknown event types. */
const EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'tool_call',
  'tool_result',
  'boot_context',
  'invoke_sent',
  'invoke_completed',
  'memory_write',
  'context_compact',
  'module_flag',
  'user_input',
  'user_interrupt',
])

export interface EventLogEntry {
  id: string
  timestamp: string  // ISO 8601
  type: EventType
  source: string     // 工具名 / agent 类型 / 系统模块
  detail: Record<string, unknown>
  tags?: string[]
}

function nextId(): string {
  return `evt_${randomUUID()}`
}

// ── Validation ─────────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Conservative schema check — returns true only if `value` matches the
 * EventLogEntry shape closely enough to be safe to forward to consumers.
 * Used by readAll() to skip garbage that survived JSON.parse.
 *
 * Required fields and their validation:
 *   - id        : non-empty string
 *   - timestamp : non-empty string parseable by Date.parse
 *   - type      : one of the EventType whitelist values
 *   - source    : non-empty string
 *   - detail    : object (not array, not primitive)
 *   - tags      : (optional) array whose every element is a string
 */
export function isValidEntry(value: unknown): value is EventLogEntry {
  if (!isObject(value)) return false
  if (typeof value.id !== 'string' || value.id.length === 0) return false
  if (typeof value.timestamp !== 'string' || value.timestamp.length === 0) return false
  if (Number.isNaN(Date.parse(value.timestamp))) return false
  if (typeof value.type !== 'string' || value.type.length === 0) return false
  if (!EVENT_TYPES.has(value.type as EventType)) return false
  if (typeof value.source !== 'string' || value.source.length === 0) return false
  if (!isObject(value.detail)) return false
  if (value.tags !== undefined) {
    if (!Array.isArray(value.tags)) return false
    if (!value.tags.every((t): t is string => typeof t === 'string')) return false
  }
  return true
}

// ── Query ───────────────────────────────────────────────────────────────────

/** Lightweight predicate — returns true to keep the entry. */
export type EventPredicate = (entry: EventLogEntry) => boolean

/**
 * Build a predicate from a structured filter. Exported for tests / callers
 * that want the same composability as the `query(filter)` convenience path.
 */
export function buildFilter(filter: {
  type?: EventType
  source?: string
  tag?: string
}): EventPredicate {
  return (entry) => {
    if (filter.type !== undefined && entry.type !== filter.type) return false
    if (filter.source !== undefined && entry.source !== filter.source) return false
    if (filter.tag !== undefined) {
      const tags = entry.tags
      if (!Array.isArray(tags) || !tags.includes(filter.tag)) return false
    }
    return true
  }
}

// ── EventLog ────────────────────────────────────────────────────────────────

export interface ReadAllOptions {
  /** Optional callback receiving count of skipped (corrupt / wrong-shape) lines. */
  onSkip?: (skipped: number) => void
}

export class EventLog {
  private filePath: string

  constructor(sessionDir: string) {
    this.filePath = join(sessionDir, 'events.ndjson')
    try { mkdirSync(sessionDir, { recursive: true }) } catch { /* best-effort */ }
  }

  /** Append a new event (best-effort, never throws). */
  append(
    type: EventType,
    source: string,
    detail: Record<string, unknown>,
    tags?: string[],
  ): EventLogEntry {
    const entry: EventLogEntry = {
      id: nextId(),
      timestamp: new Date().toISOString(),
      type,
      source,
      detail,
      tags,
    }
    try {
      appendFileSync(this.filePath, JSON.stringify(entry) + '\n', 'utf8')
    } catch {
      // silently ignore — event log must never break the engine
    }
    return entry
  }

  /**
   * Read all events from the file. Line-tolerant: a single corrupted line
   * does NOT cause the rest of the log to be discarded. Each line is parsed
   * independently and validated against the EventLogEntry shape; malformed
   * lines (bad JSON or wrong shape) are silently skipped.
   *
   * Returns [] only when the file is missing, empty, or wholly unreadable.
   */
  readAll(options: ReadAllOptions = {}): EventLogEntry[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }

    const out: EventLogEntry[] = []
    let skipped = 0
    // Split preserves trailing empty line; trim each line so we don't
    // count a single trailing newline as a corrupt entry.
    for (const rawLine of raw.split('\n')) {
      const line = rawLine.trim()
      if (line.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        skipped++
        continue
      }
      if (!isValidEntry(parsed)) {
        skipped++
        continue
      }
      out.push(parsed)
    }
    if (skipped > 0) options.onSkip?.(skipped)
    return out
  }

  /**
   * Lightweight filtered read. Two equivalent forms:
   *   query()                 → returns all valid entries
   *   query(predicate)        → returns entries for which predicate(entry) is true
   *   query({ type, source, tag }) → structured convenience filter
   *
   * Internally reuses readAll() so the same line-tolerance applies.
   */
  query(
    arg: EventPredicate | {
      type?: EventType
      source?: string
      tag?: string
    } = {},
    options: ReadAllOptions = {},
  ): EventLogEntry[] {
    const predicate: EventPredicate =
      typeof arg === 'function' ? arg : buildFilter(arg)
    return this.readAll(options).filter(predicate)
  }

  /** Get the file path (for tools that want to cat/tail it) */
  getFilePath(): string {
    return this.filePath
  }
}