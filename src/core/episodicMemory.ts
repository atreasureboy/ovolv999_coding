/**
 * EpisodicMemory — action trajectory persistence
 *
 * Records "what I did, what happened, was it successful" for each tool call
 * and agent action. Lets the agent review its recent history of attempts
 * without re-reading the full conversation.
 *
 * Storage: ~/.ovogo/projects/{slug}/memory/episodes.jsonl
 */

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export interface EpisodicMemoryEntry {
  id: string
  turn: number
  toolName: string
  inputSummary: string   // truncated input
  resultSummary: string  // truncated result
  outcome: 'success' | 'failure' | 'partial'
  duration?: number      // ms
  timestamp: string      // ISO 8601
}

const VALID_OUTCOMES: ReadonlySet<EpisodicMemoryEntry['outcome']> = new Set([
  'success', 'failure', 'partial',
])

function nextId(): string {
  return `epi_${randomUUID()}`
}

/**
 * Schema check for an episode row. Returns true iff `value` looks like a
 * valid EpisodicMemoryEntry. Used by readAll() to skip rows whose shape
 * drifted (legacy writes, partial writes, manual edits) so a single bad
 * line never breaks the entire read.
 *
 * Required fields and their validation:
 *   - id            : non-empty string
 *   - turn          : finite number (integer)
 *   - toolName      : string (may be empty)
 *   - inputSummary  : string
 *   - resultSummary : string
 *   - outcome       : one of 'success' | 'failure' | 'partial'
 *   - duration      : (optional) finite number when present
 *   - timestamp     : string
 *
 * Exported for tests / callers that want to validate a row out-of-band.
 */
export function isValidEpisode(value: unknown): value is EpisodicMemoryEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const v = value as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0) return false
  if (typeof v.turn !== 'number' || !Number.isFinite(v.turn)) return false
  if (typeof v.toolName !== 'string') return false
  if (typeof v.inputSummary !== 'string') return false
  if (typeof v.resultSummary !== 'string') return false
  if (typeof v.outcome !== 'string' || !VALID_OUTCOMES.has(v.outcome as EpisodicMemoryEntry['outcome'])) return false
  if (v.duration !== undefined && (typeof v.duration !== 'number' || !Number.isFinite(v.duration))) return false
  if (typeof v.timestamp !== 'string') return false
  return true
}

export class EpisodicMemory {
  private filePath: string

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try { mkdirSync(memDir, { recursive: true }) } catch { /* best-effort */ }
    this.filePath = join(memDir, 'episodes.jsonl')
  }

  /** Append a new episode entry */
  write(entry: Omit<EpisodicMemoryEntry, 'id'>): EpisodicMemoryEntry {
    const full: EpisodicMemoryEntry = { ...entry, id: nextId() }
    try {
      appendFileSync(this.filePath, JSON.stringify(full) + '\n', 'utf8')
    } catch { /* best-effort */ }
    return full
  }

  /** Read the most recent N episodes */
  recent(limit = 20): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.slice(-limit)
  }

  /**
   * Read all entries.
   *
   * Robustness contract:
   *   - Missing file → [].
   *   - Each line is parsed independently and validated against
   *     {@link isValidEpisode}. Corrupt or wrong-shape lines are
   *     SKIPPED rather than aborting the whole read. A single bad row
   *     no longer makes an otherwise-healthy log unreadable.
   *   - The function returns [] only when no valid entries exist
   *     (missing file / empty file / entirely unparseable content).
   */
  readAll(): EpisodicMemoryEntry[] {
    if (!existsSync(this.filePath)) return []
    let raw: string
    try {
      raw = readFileSync(this.filePath, 'utf8')
    } catch {
      return []
    }

    const out: EpisodicMemoryEntry[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.length === 0) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        // Bad JSON — skip this line, keep going.
        continue
      }
      if (!isValidEpisode(parsed)) {
        // Right JSON, wrong shape — skip this line, keep going.
        continue
      }
      out.push(parsed)
    }
    return out
  }

  /** Search episodes by tool name */
  findByTool(toolName: string, limit = 10): EpisodicMemoryEntry[] {
    const all = this.readAll()
    return all.filter((e) => e.toolName === toolName).slice(-limit)
  }
}
