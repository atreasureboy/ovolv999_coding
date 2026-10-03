import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import { createHash, randomBytes, randomUUID } from 'crypto'
import { acquirePersistenceLease, withPersistenceLock } from './persistenceLock.js'

export interface MemoryProvenance {
  status: 'unverified' | 'verified'
  claimedSource: string
  references?: string[]
  outcome?: string
  verification?: string
}

export interface SemanticMemoryEntry {
  id: string
  content: string
  tags: string[]
  source: string
  timestamp: string
  confidence: number
  provenance?: MemoryProvenance
}

export interface SemanticMemoryWriteResult extends SemanticMemoryEntry {
  persistence: 'persisted' | 'failed'
  persistenceError?: string
}

const SOURCE_PRIORITY = new Map([
  ['user_stated', 3],
  ['agent_inferred', 2],
  ['consolidation', 2],
  ['tool_observed', 1],
])

function sourceRank(source: string): number {
  return SOURCE_PRIORITY.get(source) ?? 1
}

function contentHash(content: string): string {
  return createHash('md5').update(content).digest('hex').slice(0, 12)
}

export class SemanticMemory {
  private filePath: string
  private entries = new Map<string, SemanticMemoryEntry>()
  private tagIndex = new Map<string, Set<string>>()
  private loaded = false
  private lastLoadedMtimeMs = -1
  private lastLoadedSize = -1

  constructor(projectDir: string) {
    const memDir = join(projectDir, 'memory')
    try {
      mkdirSync(memDir, { recursive: true })
    } catch (error) {
      void error
    }
    this.filePath = join(memDir, 'semantic.jsonl')
  }

  private replaceEntries(
    entries: Map<string, SemanticMemoryEntry>,
    mtimeMs: number,
    size: number,
  ): void {
    const index = new Map<string, Set<string>>()
    for (const entry of entries.values()) {
      for (const tag of entry.tags) {
        let ids = index.get(tag)
        if (!ids) index.set(tag, (ids = new Set()))
        ids.add(entry.id)
      }
    }
    this.entries = entries
    this.tagIndex = index
    this.loaded = true
    this.lastLoadedMtimeMs = mtimeMs
    this.lastLoadedSize = size
  }

  private ensureLoaded(force = false): boolean {
    try {
      const before = statSync(this.filePath)
      if (
        !force &&
        this.loaded &&
        before.mtimeMs === this.lastLoadedMtimeMs &&
        before.size === this.lastLoadedSize
      )
        return true
      const raw = readFileSync(this.filePath, 'utf8')
      const after = statSync(this.filePath)
      if (before.mtimeMs !== after.mtimeMs || before.size !== after.size) return false
      const entries = new Map<string, SemanticMemoryEntry>()
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const entry = JSON.parse(line) as SemanticMemoryEntry
          if (
            typeof entry.id !== 'string' ||
            typeof entry.content !== 'string' ||
            !Array.isArray(entry.tags)
          )
            continue
          entry.tags = entry.tags.filter((tag) => typeof tag === 'string')
          entry.provenance = {
            ...entry.provenance,
            status: 'unverified',
            claimedSource: entry.source,
          }
          entries.set(entry.id, entry)
        } catch (error) {
          void error
        }
      }
      this.replaceEntries(entries, after.mtimeMs, after.size)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.replaceEntries(new Map(), -1, 0)
        return true
      }
      return false
    }
  }

  write(entry: Omit<SemanticMemoryEntry, 'id'>): SemanticMemoryWriteResult {
    return this.writeUsing(entry, (action) => withPersistenceLock(this.filePath, action))
  }

  async writeAsync(entry: Omit<SemanticMemoryEntry, 'id'>): Promise<SemanticMemoryWriteResult> {
    try {
      const lease = await acquirePersistenceLease(this.filePath)
      try {
        return this.writeUsing(entry, (action) => {
          lease.assertOwned()
          return action()
        })
      } finally {
        lease.release()
      }
    } catch (error) {
      return {
        ...entry,
        id: `sem_${randomUUID()}`,
        persistence: 'failed',
        persistenceError: error instanceof Error ? error.message : 'Persistence failed',
      }
    }
  }

  private writeUsing(
    entry: Omit<SemanticMemoryEntry, 'id'>,
    guard: (action: () => SemanticMemoryWriteResult) => SemanticMemoryWriteResult,
  ): SemanticMemoryWriteResult {
    const full: SemanticMemoryEntry = {
      ...entry,
      id: `sem_${randomUUID()}`,
      provenance: { ...entry.provenance, status: 'unverified', claimedSource: entry.source },
    }
    try {
      return guard(() => {
        if (!this.ensureLoaded(true))
          throw new Error('Memory could not be read; write was not committed')
        const next = new Map(this.entries)
        const hash = contentHash(entry.content)
        for (const [id, existing] of next) {
          if (contentHash(existing.content) !== hash) continue
          if (sourceRank(entry.source) < sourceRank(existing.source))
            return { ...existing, persistence: 'persisted' }
          const updated: SemanticMemoryEntry = {
            ...existing,
            confidence: Math.max(existing.confidence, entry.confidence),
            timestamp: new Date().toISOString(),
            source: entry.source,
            provenance: full.provenance,
          }
          next.set(id, updated)
          this.persistAll(next)
          this.replaceEntries(next, -1, -1)
          return { ...updated, persistence: 'persisted' }
        }
        const fd = openSync(this.filePath, 'a')
        try {
          appendFileSync(fd, JSON.stringify(full) + '\n', 'utf8')
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        next.set(full.id, full)
        this.replaceEntries(next, -1, -1)
        return { ...full, persistence: 'persisted' }
      })
    } catch (error) {
      return {
        ...full,
        persistence: 'failed',
        persistenceError: error instanceof Error ? error.message : 'Persistence failed',
      }
    }
  }

  private persistAll(entries: Map<string, SemanticMemoryEntry>): void {
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}.${randomBytes(8).toString('hex')}`
    let fd: number | undefined
    try {
      fd = openSync(tmpPath, 'wx')
      writeFileSync(
        fd,
        Array.from(entries.values(), (value) => JSON.stringify(value)).join('\n') + '\n',
      )
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(tmpPath, this.filePath)
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch (error) {
          void error
        }
      }
      try {
        unlinkSync(tmpPath)
      } catch (error) {
        void error
      }
    }
  }

  /** Read all entries from the in-memory index */
  readAll(): SemanticMemoryEntry[] {
    this.ensureLoaded()
    return Array.from(this.entries.values())
  }

  /** Search by tags and/or keywords in content */
  search(options: { tags?: string[]; keywords?: string[]; limit?: number }): SemanticMemoryEntry[] {
    this.ensureLoaded()
    let results: SemanticMemoryEntry[]

    // Fast path: use tag index
    if (options.tags && options.tags.length > 0) {
      const candidateIds = new Set<string>()
      for (const tag of options.tags) {
        const ids = this.tagIndex.get(tag)
        if (ids) {
          for (const id of ids) candidateIds.add(id)
        }
      }
      results = Array.from(candidateIds)
        .map((id) => this.entries.get(id))
        .filter((e): e is SemanticMemoryEntry => e !== undefined)
    } else {
      results = Array.from(this.entries.values())
    }

    // Keyword filter (still needs full scan)
    if (options.keywords && options.keywords.length > 0) {
      const lowerKeywords = options.keywords.map((k) => k.toLowerCase())
      results = results.filter((e) =>
        lowerKeywords.some((kw) => e.content.toLowerCase().includes(kw)),
      )
    }

    // Sort by confidence descending, then by timestamp descending
    results.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return b.timestamp.localeCompare(a.timestamp)
    })

    const limit = options.limit ?? 20
    return results.slice(0, limit)
  }
}
