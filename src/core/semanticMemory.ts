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
import { acquirePersistenceLease, acquirePersistenceLeaseSync } from './persistenceLock.js'
import { isRecord, isStringArray } from './persistedData.js'

export interface MemoryProvenance {
  status: 'unverified' | 'verified'
  claimedSource: string
  references?: string[]
  outcome?: string
  verification?: string
}

export interface MemorySourceRef {
  sessionId: string
  turnId: string
  role: 'user' | 'assistant'
}

export interface SemanticMemoryEntry {
  id: string
  content: string
  tags: string[]
  source: string
  timestamp: string
  confidence: number
  provenance?: MemoryProvenance
  state: 'active' | 'superseded'
  supersedes?: string[]
  sourceRef?: MemorySourceRef
}

export type SemanticMemoryWrite = Omit<SemanticMemoryEntry, 'id' | 'state'> & { state?: 'active' }

export interface SemanticMemoryWriteResult extends SemanticMemoryEntry {
  persistence: 'persisted' | 'failed'
  persistenceError?: string
}

const MAX_SESSION_ID_BYTES = 4096
const MAX_TURN_ID_BYTES = 128
const MAX_SUPERSEDED_ID_BYTES = 128
const MAX_SUPERSEDES = 256

export function isMemorySourceRef(value: unknown): value is MemorySourceRef {
  return isRecord(value) && Reflect.ownKeys(value).length === 3
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && ['sessionId', 'turnId', 'role'].includes(key))
    && typeof value.sessionId === 'string' && Buffer.byteLength(value.sessionId, 'utf8') <= MAX_SESSION_ID_BYTES && value.sessionId.trim().length > 0
    && typeof value.turnId === 'string' && Buffer.byteLength(value.turnId, 'utf8') <= MAX_TURN_ID_BYTES && value.turnId.trim().length > 0
    && (value.role === 'user' || value.role === 'assistant')
}

export function isMemorySupersedes(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_SUPERSEDES && isStringArray(value)
    && value.every(id => Buffer.byteLength(id, 'utf8') <= MAX_SUPERSEDED_ID_BYTES && id.trim().length > 0)
    && new Set(value).size === value.length
}

export function isSemanticMemoryEntry(value: unknown): value is SemanticMemoryEntry {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.content !== 'string' || !value.content
    || !isStringArray(value.tags) || typeof value.source !== 'string' || typeof value.timestamp !== 'string'
    || typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1
    || (value.state !== undefined && value.state !== 'active' && value.state !== 'superseded')
    || (value.supersedes !== undefined && !isMemorySupersedes(value.supersedes))
    || (value.sourceRef !== undefined && !isMemorySourceRef(value.sourceRef))) return false
  const provenance = value.provenance
  return provenance === undefined || (isRecord(provenance) && typeof provenance.status === 'string' && ['unverified', 'verified'].includes(provenance.status)
    && typeof provenance.claimedSource === 'string' && (provenance.references === undefined || isStringArray(provenance.references))
    && (provenance.outcome === undefined || typeof provenance.outcome === 'string') && (provenance.verification === undefined || typeof provenance.verification === 'string'))
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
          const entry: unknown = JSON.parse(line)
          if (!isSemanticMemoryEntry(entry)) continue
          entry.state ??= 'active'
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

  private withLease<T>(action: (assertOwned: () => void) => T): T {
    const lease = acquirePersistenceLeaseSync(this.filePath)
    try {
      lease.assertOwned()
      return action(() => lease.assertOwned())
    } finally {
      lease.release()
    }
  }

  write(entry: SemanticMemoryWrite): SemanticMemoryWriteResult {
    const result = this.writeUsing(entry, (action) => this.withLease(action))
    return result.persistence === 'persisted' ? structuredClone(result) : result
  }

  async writeAsync(entry: SemanticMemoryWrite): Promise<SemanticMemoryWriteResult> {
    try {
      const snapshot = structuredClone(entry)
      const lease = await acquirePersistenceLease(this.filePath)
      try {
        const result = this.writeUsing(snapshot, (action) => {
          lease.assertOwned()
          return action(() => lease.assertOwned())
        })
        return result.persistence === 'persisted' ? structuredClone(result) : result
      } finally {
        lease.release()
      }
    } catch (error) {
      return {
        ...entry,
        id: `sem_${randomUUID()}`,
        state: 'active',
        persistence: 'failed',
        persistenceError: error instanceof Error ? error.message : 'Persistence failed',
      }
    }
  }

  private writeUsing(
    entry: SemanticMemoryWrite,
    guard: (action: (assertOwned: () => void) => SemanticMemoryWriteResult) => SemanticMemoryWriteResult,
  ): SemanticMemoryWriteResult {
    let full: SemanticMemoryEntry = {
      ...entry,
      id: `sem_${randomUUID()}`,
      state: 'active',
      provenance: { ...entry.provenance, status: 'unverified', claimedSource: entry.source },
    }
    try {
      full = structuredClone(full)
      if (!isSemanticMemoryEntry(full) || (entry.state !== undefined && entry.state !== 'active'))
        throw new Error('Invalid semantic memory metadata; write was not committed')
      return guard((assertOwned) => {
        if (!this.ensureLoaded(true))
          throw new Error('Memory could not be read; write was not committed')
        const next = new Map(this.entries)
        if (full.supersedes !== undefined) {
          next.set(full.id, full)
          this.applySupersession(next, full.supersedes, full.id)
          this.persistAll(next, assertOwned)
          this.replaceEntries(next, -1, -1)
          return { ...next.get(full.id)!, persistence: 'persisted' }
        }
        const hash = contentHash(full.content)
        const matches = Array.from(next).filter(([, existing]) => contentHash(existing.content) === hash)
        const match = matches.find(([, existing]) => existing.state === 'active') ?? matches[0]
        if (match) {
          const [id, existing] = match
          if (existing.state === 'superseded' || sourceRank(full.source) < sourceRank(existing.source))
            return { ...existing, persistence: 'persisted' }
          const updated: SemanticMemoryEntry = {
            ...existing,
            confidence: Math.max(existing.confidence, full.confidence),
            timestamp: new Date().toISOString(),
            source: full.source,
            provenance: full.provenance,
            sourceRef: full.sourceRef,
          }
          next.set(id, updated)
          this.persistAll(next, assertOwned)
          this.replaceEntries(next, -1, -1)
          return { ...updated, persistence: 'persisted' }
        }
        assertOwned()
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

  private applySupersession(entries: Map<string, SemanticMemoryEntry>, oldIds: readonly string[], replacementId: string): void {
    if (!isMemorySupersedes(oldIds)) throw new Error('Invalid memory supersession IDs; write was not committed')
    const replacement = entries.get(replacementId)
    if (!replacement) throw new Error(`Unknown replacement memory ID: ${replacementId}`)
    if (replacement.state !== 'active') throw new Error(`Replacement memory is superseded or stale: ${replacementId}`)
    for (const oldId of oldIds) {
      if (oldId === replacementId) throw new Error('Memory cannot supersede itself')
      const old = entries.get(oldId)
      if (!old) throw new Error(`Unknown superseded memory ID: ${oldId}`)
      if (old.state !== 'active') throw new Error(`Memory is superseded or stale: ${oldId}`)
      if (sourceRank(replacement.source) < sourceRank(old.source))
        throw new Error(`Replacement source cannot override higher-priority memory: ${oldId}`)
    }
    const linked = { ...replacement, supersedes: [...new Set([...(replacement.supersedes ?? []), ...oldIds])] }
    if (!isMemorySupersedes(linked.supersedes)) throw new Error('Invalid merged memory supersession metadata; write was not committed')
    entries.set(replacementId, linked)
    const pending = [{ id: replacementId, exit: false }]
    const visiting = new Set<string>()
    const visited = new Set<string>()
    while (pending.length > 0) {
      const current = pending.pop()!
      if (current.exit) {
        visiting.delete(current.id)
        visited.add(current.id)
        continue
      }
      if (visiting.has(current.id)) throw new Error('Cyclic memory supersession; write was not committed')
      if (visited.has(current.id)) continue
      const ancestor = entries.get(current.id)
      if (!ancestor) throw new Error(`Unknown supersession ancestor: ${current.id}`)
      visiting.add(current.id)
      pending.push({ id: current.id, exit: true })
      for (const id of ancestor.supersedes ?? []) pending.push({ id, exit: false })
    }
    for (const oldId of oldIds) entries.set(oldId, { ...entries.get(oldId)!, state: 'superseded' })
  }

  supersedeMemory(oldIds: readonly string[], replacementId: string): void {
    this.withLease((assertOwned) => {
      if (!this.ensureLoaded(true)) throw new Error('Memory could not be read; supersession was not committed')
      const next = new Map(this.entries)
      this.applySupersession(next, oldIds, replacementId)
      this.persistAll(next, assertOwned)
      this.replaceEntries(next, -1, -1)
    })
  }

  private persistAll(entries: Map<string, SemanticMemoryEntry>, assertOwned: () => void): void {
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
      assertOwned()
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
    if (!this.ensureLoaded()) return []
    return structuredClone(Array.from(this.entries.values()))
  }

  /** Search by tags and/or keywords in content */
  search(options: { tags?: string[]; keywords?: string[]; limit?: number }): SemanticMemoryEntry[] {
    if (!this.ensureLoaded()) return []
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
    results = results.filter(entry => entry.state === 'active')

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
    return structuredClone(results.slice(0, limit))
  }
}
