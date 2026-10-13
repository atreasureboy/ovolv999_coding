import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquirePersistenceLeaseSync, type PersistenceLease } from './persistenceLock.js'
import { inspectProcessIdentitySync, type ProcessIdentity } from './processIdentity.js'
import type { AgentEvent, AgentEventInput, AgentThreadSnapshot } from './agentEvents.js'

export interface AgentEventStoreOptions {
  sessionDir: string
  threadId: string
  cwd: string
  maxSegmentBytes?: number
  maxSegments?: number
  maxEventBytes?: number
  readOnly?: boolean
}

interface Segment {
  name: string
  firstSequence: number
  lastSequence: number
  bytes: number
  endsCompletedTurn: boolean
}

interface Checkpoint {
  name: string
  sequence: number
  turnId: string
  historyRevision: number
}

interface Manifest {
  schemaVersion: 1
  threadId: string
  cwd: string
  firstAvailableSequence: number
  lastSequence: number
  segments: Segment[]
  checkpoint: Checkpoint | null
  writer: { owner: ProcessIdentity; token: string } | null
  interrupted: boolean
}

export class CursorExpiredError extends Error {
  readonly code = 'cursor_expired'

  constructor(readonly firstAvailableSequence: number, readonly snapshotPath: string) {
    super(`Event cursor expired; first available sequence is ${firstAvailableSequence}. Load ${snapshotPath} before reconnecting.`)
    this.name = 'CursorExpiredError'
  }
}

export class CorruptEventStoreError extends Error {
  readonly code = 'corrupt_event_store'

  constructor(readonly storePath: string, message: string, cause?: unknown) {
    super(`Corrupt event store at ${storePath}: ${message}; original files were preserved`, { cause })
    this.name = 'CorruptEventStoreError'
  }
}

export class EventStoreCapacityError extends Error {
  readonly code = 'event_store_capacity'

  constructor() {
    super('Event store capacity is exhausted by turns without a covering completed checkpoint')
    this.name = 'EventStoreCapacityError'
  }
}

const outcomeStatuses = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'limit_reached', 'blocked', 'needs_input'])
const itemKinds = new Set(['message', 'tool', 'verification'])
const decoder = new TextDecoder('utf-8', { fatal: true })

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) && value !== '..'
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function privateFile(path: string, allowMissing = false): void {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) throw new Error(`Unsafe event file path ${path}`)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function canonicalDirectory(path: string, label: string): string {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error(`${label} must be an absolute directory path`)
  const normalized = resolve(path)
  if (lstatSync(normalized).isSymbolicLink()) throw new Error(`${label} symbolic directory paths are not supported`)
  const canonical = realpathSync(normalized)
  if (!lstatSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`)
  return canonical
}

function readBounded(path: string, maxBytes: number): Buffer {
  privateFile(path)
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink > 1) throw new Error(`Unsafe event file path ${path}`)
    if (!integer(stat.size) || stat.size > maxBytes) throw new Error(`Event file byte limit exceeded (${maxBytes}) at ${path}`)
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error(`Event file ended during bounded read at ${path}`)
      offset += count
    }
    return bytes
  } finally { closeSync(fd) }
}

function writeAll(fd: number, bytes: Buffer): void {
  let offset = 0
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset)
    if (!written) throw new Error('Event persistence made no progress')
    offset += written
  }
}

function emptySnapshot(threadId: string, cwd: string): AgentThreadSnapshot {
  return { schemaVersion: 1, threadId, cwd, historyRevision: 0, lastSequence: 0, firstAvailableSequence: 1, activeTurn: null, lastTurn: null, items: [], pendingApprovals: [], recovery: 'clean' }
}

function validateEvent(value: unknown, threadId: string, cwd: string): asserts value is AgentEvent {
  if (!record(value) || value.schemaVersion !== 1 || value.threadId !== threadId || !identity(value.turnId) || !integer(value.sequence, 1)) throw new Error('Invalid event identity or sequence')
  if (value.type === 'turn.started') {
    if (value.runId !== value.turnId || value.cwd !== cwd || !integer(value.historyRevision)) throw new Error('Invalid turn start')
  } else if (value.type === 'item.started' || value.type === 'item.completed') {
    if (!identity(value.itemId) || typeof value.kind !== 'string' || !itemKinds.has(value.kind)) throw new Error('Invalid item identity or kind')
    if (value.role !== undefined && value.role !== 'user' && value.role !== 'assistant') throw new Error('Invalid message role')
    for (const key of ['name', 'toolCallId', 'inputDigest', 'preview', 'workspace', 'expectedTurnId']) {
      if (value[key] !== undefined && typeof value[key] !== 'string') throw new Error(`Invalid item ${key}`)
    }
    if (value.type === 'item.completed') {
      if (typeof value.status !== 'string' || (!outcomeStatuses.has(value.status) && value.status !== 'partial')) throw new Error('Invalid item terminal status')
      if (typeof value.result !== 'string' && (!record(value.result) || typeof value.result.content !== 'string' || typeof value.result.isError !== 'boolean')) throw new Error('Invalid item result')
      if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error('Invalid item truncation flag')
      if (value.artifact !== undefined && typeof value.artifact !== 'string') throw new Error('Invalid item artifact')
    }
  } else if (value.type === 'item.delta') {
    if (!identity(value.itemId) || typeof value.text !== 'string' || (value.channel !== undefined && value.channel !== 'text' && value.channel !== 'reasoning')) throw new Error('Invalid item delta')
  } else if (value.type === 'turn.finished') {
    if (typeof value.status !== 'string' || !outcomeStatuses.has(value.status) || !integer(value.historyRevision) || !record(value.result) || typeof value.result.output !== 'string' || typeof value.result.stopped !== 'boolean' || !['max_iterations', 'stop_sequence', 'error', 'interrupted'].includes(String(value.result.reason))) throw new Error('Invalid turn terminal')
    if (value.result.runId !== undefined && value.result.runId !== value.turnId) throw new Error('Turn result identity mismatch')
    if (value.result.status !== undefined && value.result.status !== value.status) throw new Error('Turn result status mismatch')
    if (value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error('Invalid turn truncation flag')
    if (value.artifact !== undefined && typeof value.artifact !== 'string') throw new Error('Invalid turn artifact')
  } else if (value.type === 'approval.requested') {
    const request = value.request
    if (!record(request) || !identity(request.requestId) || request.runId !== value.turnId || request.cwd !== cwd || typeof request.operationId !== 'string' || typeof request.inputDigest !== 'string' || typeof request.tool !== 'string' || typeof request.preview !== 'string' || Object.hasOwn(request, 'signal')) throw new Error('Invalid approval request')
    if (request.policyDigest !== undefined && typeof request.policyDigest !== 'string') throw new Error('Invalid approval policy digest')
  } else if (value.type === 'approval.resolved') {
    const decision = value.decision
    if (!record(decision) || !identity(decision.requestId) || decision.cwd !== cwd || typeof decision.inputDigest !== 'string' || !['allow', 'deny'].includes(String(decision.action)) || !['once', 'session', 'rule'].includes(String(decision.scope)) || !['decided', 'needs_input', 'cancelled', 'stale'].includes(String(decision.status))) throw new Error('Invalid approval decision')
  } else if (value.type === 'error') {
    if (typeof value.code !== 'string' || !value.code || typeof value.message !== 'string') throw new Error('Invalid error event')
  } else throw new Error('Unknown event type')
}

function applyEvent(state: AgentThreadSnapshot, event: AgentEvent): void {
  if (event.type === 'turn.started') {
    if (state.activeTurn || state.lastTurn?.turnId === event.turnId || event.historyRevision < state.historyRevision) throw new Error('Turn start conflicts with the active or completed turn')
    if (state.recovery === 'recovery_required') throw new Error('Thread requires explicit recovery before another turn')
    if (state.pendingApprovals.length) throw new Error('Unresolved approvals require explicit recovery before another turn')
    state.items = []
    state.activeTurn = { turnId: event.turnId, runId: event.runId, cwd: event.cwd, historyRevision: event.historyRevision, status: 'running', startedSequence: event.sequence }
    state.historyRevision = event.historyRevision
    state.recovery = 'clean'
  } else {
    if (state.activeTurn?.turnId !== event.turnId) throw new Error('Event does not belong to the active turn')
    if (event.type === 'item.started') {
      if (state.items.some(item => item.itemId === event.itemId)) throw new Error('Item already started')
      const { type: _type, schemaVersion: _version, sequence, threadId: _thread, ...fields } = event
      void _type; void _version; void _thread
      state.items.push({ ...fields, startedSequence: sequence, status: 'running', text: '' })
    } else if (event.type === 'item.delta' || event.type === 'item.completed') {
      const item = state.items.find(candidate => candidate.itemId === event.itemId)
      if (!item || item.status !== 'running') throw new Error('Item is missing or already completed')
      if (event.type === 'item.delta') {
        if (event.channel === 'reasoning') item.reasoning = (item.reasoning ?? '') + event.text
        else item.text += event.text
      } else {
        if (item.kind !== event.kind) throw new Error('Item terminal kind does not match its start')
        item.status = event.status
        item.completedSequence = event.sequence
        item.result = event.result
        for (const key of ['verification', 'truncated', 'artifact'] as const) {
          if (event[key] !== undefined) Object.assign(item, { [key]: event[key] })
        }
      }
    } else if (event.type === 'turn.finished') {
      if (state.items.some(item => item.status === 'running')) throw new Error('Every started item must have a terminal before the turn is completed')
      if (event.historyRevision < state.historyRevision) throw new Error('History revision moved backwards')
      state.lastTurn = { ...state.activeTurn, historyRevision: event.historyRevision, status: event.status, result: event.result, finishedSequence: event.sequence }
      if (event.truncated !== undefined) state.lastTurn.truncated = event.truncated
      if (event.artifact !== undefined) state.lastTurn.artifact = event.artifact
      state.activeTurn = null
      state.historyRevision = event.historyRevision
    } else if (event.type === 'approval.requested') {
      if (state.pendingApprovals.some(request => request.requestId === event.request.requestId)) throw new Error('Approval request is already pending')
      state.pendingApprovals.push({ ...event.request, status: 'needs_input' })
    } else if (event.type === 'approval.resolved') {
      const pending = state.pendingApprovals.find(request => request.requestId === event.decision.requestId)
      if (!pending || pending.inputDigest !== event.decision.inputDigest || pending.runId !== event.turnId || pending.cwd !== event.decision.cwd) throw new Error('Approval decision does not match its request')
      if (event.decision.status === 'needs_input') pending.status = 'needs_input'
      else state.pendingApprovals = state.pendingApprovals.filter(request => request !== pending)
    } else if (event.type === 'error' && event.code === 'history_persistence_failed') state.recovery = 'recovery_required'
  }
  state.lastSequence = event.sequence
}

export class AgentEventStore {
  private readonly directory: string
  private readonly manifestPath: string
  private readonly threadId: string
  private readonly cwd: string
  private readonly maxSegmentBytes: number
  private readonly maxSegments: number
  private readonly maxEventBytes: number
  private readonly readOnly: boolean
  private lease: PersistenceLease | null = null
  private manifest: Manifest
  private state: AgentThreadSnapshot
  private events: AgentEvent[] = []
  private closed = false
  private failed: unknown = null
  private readonly subscriptions = new Map<() => void, () => void>()

  constructor(options: AgentEventStoreOptions) {
    if (!identity(options.threadId)) throw new Error('Invalid thread identity')
    this.threadId = options.threadId
    this.cwd = canonicalDirectory(options.cwd, 'cwd')
    const sessionDir = canonicalDirectory(options.sessionDir, 'sessionDir')
    this.directory = join(sessionDir, 'agent-events')
    this.manifestPath = join(this.directory, 'manifest.json')
    this.readOnly = options.readOnly === true
    this.maxSegmentBytes = options.maxSegmentBytes ?? 4 * 1024 * 1024
    this.maxSegments = options.maxSegments ?? 8
    this.maxEventBytes = options.maxEventBytes ?? 128 * 1024
    if (!integer(this.maxSegmentBytes, 1) || !integer(this.maxSegments, 1) || !integer(this.maxEventBytes, 1) || this.maxSegmentBytes > 4 * 1024 * 1024 || this.maxSegments > 8 || this.maxEventBytes > 128 * 1024) throw new Error('Invalid event store capacity options')
    this.state = emptySnapshot(this.threadId, this.cwd)
    this.manifest = { schemaVersion: 1, threadId: this.threadId, cwd: this.cwd, firstAvailableSequence: 1, lastSequence: 0, segments: [], checkpoint: null, writer: null, interrupted: false }
    if (existsSync(this.directory)) this.assertDirectory()
    else if (!this.readOnly) mkdirSync(this.directory, { mode: 0o700 })
    try {
      if (!this.readOnly) this.lease = acquirePersistenceLeaseSync(join(this.directory, 'writer'))
      this.refresh(!this.readOnly)
      if (!this.readOnly) {
        this.manifest.interrupted = this.state.activeTurn !== null
        this.manifest.writer = { owner: this.lease!.owner, token: this.lease!.token }
        this.saveManifest(this.manifest)
        this.cleanupRetired()
      }
    } catch (error) {
      this.lease?.release()
      this.lease = null
      throw error
    }
  }

  append(input: AgentEventInput): AgentEvent {
    this.assertWritable()
    if (!record(input) || ['schemaVersion', 'sequence', 'threadId'].some(key => Object.hasOwn(input, key))) throw new Error('Event input must not override the durable identity or sequence')
    const sequence = this.manifest.lastSequence + 1
    if (!integer(sequence, 1)) throw new Error('Event sequence exhausted')
    const encoded = JSON.stringify({ ...input, schemaVersion: 1, sequence, threadId: this.threadId })
    const bytes = Buffer.from(`${encoded}\n`, 'utf8')
    if (bytes.length > this.maxEventBytes || bytes.length > this.maxSegmentBytes) throw new Error(`Event exceeds event size limit in bytes (${Math.min(this.maxEventBytes, this.maxSegmentBytes)})`)
    const event: unknown = JSON.parse(encoded)
    validateEvent(event, this.threadId, this.cwd)
    const nextState = clone(this.state)
    applyEvent(nextState, event)
    const nextManifest = clone(this.manifest)
    const previous = nextManifest.segments.at(-1)
    const rotate = !previous || event.type === 'turn.started' || previous.bytes + bytes.length > this.maxSegmentBytes
    if (rotate) nextManifest.segments.push({ name: `segment-${String(sequence).padStart(16, '0')}.jsonl`, firstSequence: sequence, lastSequence: sequence - 1, bytes: 0, endsCompletedTurn: false })
    const removed = this.retain(nextManifest)
    const segment = nextManifest.segments.at(-1)!
    const path = join(this.directory, segment.name)
    privateFile(path, rotate)
    segment.bytes += bytes.length
    segment.lastSequence = sequence
    segment.endsCompletedTurn = event.type === 'turn.finished'
    nextManifest.lastSequence = sequence
    if (event.type === 'turn.finished') nextManifest.interrupted = false
    nextState.firstAvailableSequence = nextManifest.firstAvailableSequence
    let fd: number | null = null
    try {
      this.lease!.assertOwned()
      fd = openSync(path, rotate ? 'wx' : 'a', 0o600)
      writeAll(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      this.lease!.assertOwned()
      this.saveManifest(nextManifest)
    } catch (error) {
      this.failed = error
      if (fd !== null) closeSync(fd)
      this.wake()
      throw error
    }
    this.manifest = nextManifest
    this.state = nextState
    this.events = this.events.filter(existing => existing.sequence >= nextManifest.firstAvailableSequence)
    this.events.push(event)
    this.wake()
    try {
      for (const old of removed) this.removeRetained(old)
    } catch (error) {
      this.failed = error
      this.wake()
      throw error
    }
    return clone(event)
  }

  read(afterSequence: number, limit = 256): readonly AgentEvent[] {
    this.assertOpen()
    this.validateCursor(afterSequence)
    if (!integer(limit, 1)) throw new Error('Read limit must be a positive safe integer')
    if (this.readOnly) this.refresh(false)
    if (afterSequence < this.manifest.firstAvailableSequence - 1) throw new CursorExpiredError(this.manifest.firstAvailableSequence, this.snapshotPath())
    const offset = Math.max(0, afterSequence + 1 - this.manifest.firstAvailableSequence)
    return clone(this.events.slice(offset, offset + Math.min(limit, 256)))
  }

  snapshot(): AgentThreadSnapshot {
    this.assertOpen()
    if (this.readOnly) this.refresh(false)
    const snapshot = clone(this.state)
    if (snapshot.activeTurn && (this.manifest.interrupted || !this.writerAlive(this.manifest))) snapshot.recovery = 'interrupted'
    return snapshot
  }

  checkpoint(input: { historyRevision: number; turnId: string }): AgentThreadSnapshot {
    this.assertWritable()
    if (this.state.activeTurn) throw new Error('Cannot checkpoint an active turn; a completed turn is required')
    if (this.state.recovery !== 'clean') throw new Error('Cannot checkpoint a thread that requires explicit recovery')
    if (!integer(input.historyRevision) || this.state.lastTurn?.turnId !== input.turnId || this.state.lastTurn.finishedSequence !== this.manifest.lastSequence || this.state.historyRevision !== input.historyRevision) throw new Error('Checkpoint does not match the committed completed turn and history revision')
    const snapshot = this.snapshot()
    const checkpoint: Checkpoint = { name: `snapshot-${String(snapshot.lastSequence).padStart(16, '0')}.json`, sequence: snapshot.lastSequence, turnId: input.turnId, historyRevision: input.historyRevision }
    const nextManifest = { ...this.manifest, checkpoint }
    try {
      this.atomicReplace(join(this.directory, checkpoint.name), snapshot)
      this.saveManifest(nextManifest)
      this.manifest = nextManifest
      this.cleanupRetired()
    } catch (error) {
      this.failed = error
      this.wake()
      throw error
    }
    return snapshot
  }

  subscribe(afterSequence: number, options: { signal?: AbortSignal } = {}): AsyncIterableIterator<AgentEvent> {
    this.assertOpen()
    this.validateCursor(afterSequence)
    let cursor = afterSequence
    let stopped = false
    let pending = false
    let notify: (() => void) | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const wake = () => { const continuation = notify; notify = null; continuation?.() }
    const stop = () => {
      stopped = true
      this.subscriptions.delete(wake)
      options.signal?.removeEventListener('abort', stop)
      if (timer) { clearTimeout(timer); timer = null }
      wake()
    }
    this.subscriptions.set(wake, stop)
    options.signal?.addEventListener('abort', stop, { once: true })
    if (options.signal?.aborted) stop()
    const iterator: AsyncIterableIterator<AgentEvent> = {
      [Symbol.asyncIterator]() { return iterator },
      next: async () => {
        if (pending) throw new Error('Concurrent subscription reads are not supported')
        pending = true
        try {
          for (;;) {
            if (stopped || this.closed) { stop(); return { value: undefined, done: true } }
            const events = this.read(cursor, 1)
            if (events.length) { cursor = events[0].sequence; return { value: events[0], done: false } }
            await new Promise<void>(resolveWake => {
              notify = resolveWake
              if (this.readOnly) timer = setTimeout(() => { timer = null; wake() }, 50)
            })
          }
        } catch (error) { stop(); throw error } finally { pending = false }
      },
      return: () => { stop(); return Promise.resolve({ value: undefined, done: true }) },
      throw: (error?: unknown) => { stop(); return Promise.reject(error instanceof Error ? error : new Error('Event subscription terminated', { cause: error })) },
    }
    return iterator
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const stop of [...this.subscriptions.values()]) stop()
    this.subscriptions.clear()
    try {
      if (this.lease && !this.failed) {
        this.lease.assertOwned()
        this.saveManifest({ ...this.manifest, writer: null })
      }
    } finally {
      this.lease?.release()
      this.lease = null
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Event store is closed')
    if (this.failed) throw new Error('Event store writer failed; preserve files and reopen for diagnosis', { cause: this.failed })
  }

  private assertWritable(): void {
    this.assertOpen()
    if (this.readOnly) throw new Error('Event store is read-only')
    this.assertDirectory()
    this.lease!.assertOwned()
  }

  private assertDirectory(): void {
    const stat = lstatSync(this.directory)
    if (stat.isSymbolicLink() || !stat.isDirectory() || realpathSync(this.directory) !== this.directory) throw new Error(`Unsafe event storage directory path ${this.directory}`)
  }

  private validateCursor(cursor: number): void {
    if (!integer(cursor)) throw new Error('Event cursor sequence must be a nonnegative safe integer')
  }

  private snapshotPath(): string {
    return join(this.directory, this.manifest.checkpoint?.name ?? 'snapshot.json')
  }

  private writerAlive(manifest: Manifest): boolean {
    if (manifest.writer === null || inspectProcessIdentitySync(manifest.writer.owner) !== 'matching') return false
    try {
      const root = join(this.directory, 'writer.lock.owners')
      const identity = { pid: manifest.writer.owner.pid, hostname: manifest.writer.owner.hostname, birthId: manifest.writer.owner.birthId }
      const owner = join(root, Buffer.from(JSON.stringify({ owner: identity, token: manifest.writer.token })).toString('base64url'))
      if (canonicalDirectory(root, 'writer lease') !== root || canonicalDirectory(owner, 'writer owner') !== owner) return false
      const ticket = join(owner, 'ticket')
      return integer(Number(readBounded(ticket, 32).toString('utf8')), 1)
    } catch { return false }
  }

  private atomicReplace(path: string, value: unknown): void {
    this.lease!.assertOwned()
    privateFile(path, true)
    const temporary = `${path}.tmp-${randomUUID()}`
    let fd: number | null = null
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeAll(fd, Buffer.from(JSON.stringify(value), 'utf8'))
      fsyncSync(fd)
      closeSync(fd)
      fd = null
      this.lease!.assertOwned()
      renameSync(temporary, path)
    } catch (error) {
      if (fd !== null) closeSync(fd)
      throw error
    }
  }

  private saveManifest(manifest: Manifest): void {
    this.atomicReplace(this.manifestPath, manifest)
  }

  private retain(manifest: Manifest): Segment[] {
    if (manifest.segments.length <= this.maxSegments) return []
    let count = 0
    for (let index = 0; index < manifest.segments.length - 1; index++) {
      const segment = manifest.segments[index]
      if (segment.lastSequence > (manifest.checkpoint?.sequence ?? 0)) break
      if (segment.endsCompletedTurn && manifest.segments.length - index - 1 <= this.maxSegments) { count = index + 1; break }
    }
    if (!count) throw new EventStoreCapacityError()
    const removed = manifest.segments.splice(0, count)
    manifest.firstAvailableSequence = manifest.segments[0].firstSequence
    return removed
  }

  private removeRetained(segment: Segment): void {
    const path = join(this.directory, segment.name)
    privateFile(path)
    unlinkSync(path)
  }

  private cleanupRetired(): void {
    this.lease!.assertOwned()
    for (const name of readdirSync(this.directory)) {
      const segment = /^segment-(\d{16})\.jsonl$/.exec(name)
      const snapshot = /^snapshot-(\d{16})\.json$/.exec(name)
      if (segment && Number(segment[1]) >= this.manifest.firstAvailableSequence) continue
      if (snapshot && Number(snapshot[1]) >= (this.manifest.checkpoint?.sequence ?? 0)) continue
      if (!segment && !snapshot) continue
      const path = join(this.directory, name)
      privateFile(path)
      this.lease!.assertOwned()
      unlinkSync(path)
    }
  }

  private readJson(path: string, maxBytes = 64 * 1024): unknown {
    return JSON.parse(decoder.decode(readBounded(path, maxBytes))) as unknown
  }

  private refresh(strict: boolean): void {
    if (!existsSync(this.directory)) {
      if (this.readOnly) return
      throw new CorruptEventStoreError(this.directory, 'Missing storage directory')
    }
    this.assertDirectory()
    try {
      if (!existsSync(this.manifestPath)) {
        if (readdirSync(this.directory).some(name => name.endsWith('.jsonl') || name.startsWith('snapshot-') || name.startsWith('manifest.json.tmp-'))) throw new Error('Missing retention manifest or abandoned metadata write')
        return
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const manifest = this.readJson(this.manifestPath)
        this.validateManifest(manifest)
        const events: AgentEvent[] = []
        let state = emptySnapshot(this.threadId, this.cwd)
        const replay = emptySnapshot(this.threadId, this.cwd)
        let nextSequence = manifest.firstAvailableSequence
        let changed = false
        try {
          if (manifest.checkpoint) state = this.loadCheckpoint(manifest.checkpoint)
          for (const segment of manifest.segments) {
            const path = join(this.directory, segment.name)
            const bytes = readBounded(path, this.maxSegmentBytes + 1)
            if (bytes.length !== segment.bytes && (strict || bytes.length < segment.bytes || !this.writerAlive(manifest))) throw new Error('Uncommitted or incomplete event segment tail')
            const committed = bytes.subarray(0, segment.bytes)
            if (!committed.length || committed.at(-1) !== 10) throw new Error('Incomplete event line')
            const lines = decoder.decode(committed).slice(0, -1).split('\n')
            for (const line of lines) {
              if (Buffer.byteLength(line, 'utf8') + 1 > this.maxEventBytes) throw new Error('Event byte limit exceeded')
              const event: unknown = JSON.parse(line)
              validateEvent(event, this.threadId, this.cwd)
              if (event.sequence !== nextSequence++) throw new Error('Duplicate, missing, or backwards event sequence')
              events.push(event)
              applyEvent(replay, event)
              if (event.sequence === manifest.checkpoint?.sequence && !isDeepStrictEqual({ ...replay, firstAvailableSequence: state.firstAvailableSequence }, state)) throw new Error('Checkpoint does not match its retained completed turn')
              if (event.sequence > state.lastSequence) applyEvent(state, event)
            }
            if (events.at(-1)?.sequence !== segment.lastSequence || (events.at(-1)?.type === 'turn.finished') !== segment.endsCompletedTurn) throw new Error('Segment boundary mismatch')
          }
          if (nextSequence !== manifest.lastSequence + 1 || state.lastSequence !== manifest.lastSequence) throw new Error('Committed sequence gap')
          const entries = readdirSync(this.directory)
          if (entries.some(name => /^(manifest\.json|snapshot-\d{16}\.json)\.tmp-/.test(name)) && (strict || !this.writerAlive(manifest))) throw new Error('Abandoned event metadata write requires recovery')
          const names = new Set(manifest.segments.map(segment => segment.name))
          for (const name of entries.filter(name => name.endsWith('.jsonl') && !names.has(name))) {
            const match = /^segment-(\d{16})\.jsonl$/.exec(name)
            if (!match) throw new Error('Unexpected event segment identity')
            const firstSequence = Number(match[1])
            if (firstSequence >= manifest.firstAvailableSequence && (strict || !this.writerAlive(manifest))) throw new Error('Uncommitted event segment')
          }
        } catch (error) {
          const latest = this.readJson(this.manifestPath)
          changed = JSON.stringify(latest) !== JSON.stringify(manifest)
          if (!changed || attempt === 2) throw error
        }
        if (changed) continue
        state.firstAvailableSequence = manifest.firstAvailableSequence
        this.manifest = manifest
        this.events = events
        this.state = state
        return
      }
    } catch (error) {
      if (error instanceof CorruptEventStoreError) throw error
      throw new CorruptEventStoreError(this.directory, error instanceof Error ? error.message : String(error), error)
    }
  }

  private validateManifest(value: unknown): asserts value is Manifest {
    if (!record(value) || value.schemaVersion !== 1 || value.threadId !== this.threadId || value.cwd !== this.cwd || !integer(value.firstAvailableSequence, 1) || !integer(value.lastSequence) || value.firstAvailableSequence > value.lastSequence + 1 || !Array.isArray(value.segments) || value.segments.length > this.maxSegments || typeof value.interrupted !== 'boolean') throw new Error('Invalid retention manifest identity or bounds')
    let next = value.firstAvailableSequence
    for (const segment of value.segments) {
      if (!record(segment) || !integer(segment.firstSequence, 1) || !integer(segment.lastSequence, segment.firstSequence) || !integer(segment.bytes, 1) || segment.bytes > this.maxSegmentBytes || typeof segment.endsCompletedTurn !== 'boolean' || segment.firstSequence !== next || segment.name !== `segment-${String(segment.firstSequence).padStart(16, '0')}.jsonl`) throw new Error('Invalid retention segment or sequence gap')
      next = segment.lastSequence + 1
    }
    if (next !== value.lastSequence + 1) throw new Error('Missing committed event segment')
    if (value.checkpoint !== null) {
      const checkpoint = value.checkpoint
      if (!record(checkpoint) || !integer(checkpoint.sequence, 1) || checkpoint.sequence > value.lastSequence || !integer(checkpoint.historyRevision) || !identity(checkpoint.turnId) || checkpoint.name !== `snapshot-${String(checkpoint.sequence).padStart(16, '0')}.json`) throw new Error('Invalid checkpoint manifest')
    }
    if (value.firstAvailableSequence > 1 && (!record(value.checkpoint) || !integer(value.checkpoint.sequence) || value.checkpoint.sequence < value.firstAvailableSequence - 1)) throw new Error('Retention is not covered by a checkpoint')
    if (value.writer !== null && (!record(value.writer) || typeof value.writer.token !== 'string' || !record(value.writer.owner) || !integer(value.writer.owner.pid, 1) || typeof value.writer.owner.birthId !== 'string' || typeof value.writer.owner.hostname !== 'string')) throw new Error('Invalid writer identity')
  }

  private loadCheckpoint(checkpoint: Checkpoint): AgentThreadSnapshot {
    const value = this.readJson(join(this.directory, checkpoint.name), 64 * 1024 + 2 * this.maxSegments * this.maxSegmentBytes)
    if (!record(value) || value.schemaVersion !== 1 || value.threadId !== this.threadId || value.cwd !== this.cwd || value.lastSequence !== checkpoint.sequence || value.historyRevision !== checkpoint.historyRevision || !integer(value.firstAvailableSequence, 1) || value.firstAvailableSequence > checkpoint.sequence + 1 || value.activeTurn !== null || !record(value.lastTurn) || value.lastTurn.turnId !== checkpoint.turnId || value.lastTurn.runId !== checkpoint.turnId || value.lastTurn.cwd !== this.cwd || value.lastTurn.historyRevision !== checkpoint.historyRevision || value.lastTurn.finishedSequence !== checkpoint.sequence || !integer(value.lastTurn.startedSequence, 1) || value.lastTurn.startedSequence >= checkpoint.sequence || !Array.isArray(value.items) || !Array.isArray(value.pendingApprovals) || value.recovery !== 'clean') throw new Error('Invalid completed-turn checkpoint')
    validateEvent({ ...value.lastTurn, type: 'turn.finished', schemaVersion: 1, threadId: this.threadId, sequence: checkpoint.sequence }, this.threadId, this.cwd)
    const itemIds = new Set<string>()
    for (const item of value.items) {
      if (!record(item) || !identity(item.itemId) || itemIds.has(item.itemId) || item.turnId !== checkpoint.turnId || typeof item.text !== 'string' || (item.reasoning !== undefined && typeof item.reasoning !== 'string') || !integer(item.startedSequence, 1) || !integer(item.completedSequence, item.startedSequence + 1) || item.completedSequence >= checkpoint.sequence) throw new Error('Invalid completed checkpoint item')
      validateEvent({ ...item, type: 'item.completed', schemaVersion: 1, threadId: this.threadId, sequence: item.completedSequence }, this.threadId, this.cwd)
      itemIds.add(item.itemId)
    }
    const requestIds = new Set<string>()
    for (const pending of value.pendingApprovals) {
      if (!record(pending) || !identity(pending.requestId) || requestIds.has(pending.requestId) || !['queued', 'active', 'needs_input'].includes(String(pending.status))) throw new Error('Invalid checkpoint approval')
      validateEvent({ type: 'approval.requested', request: pending, schemaVersion: 1, sequence: checkpoint.sequence, threadId: this.threadId, turnId: pending.runId }, this.threadId, this.cwd)
      requestIds.add(pending.requestId)
      pending.status = 'needs_input'
    }
    return value as unknown as AgentThreadSnapshot
  }

  private wake(): void {
    for (const listener of this.subscriptions.keys()) listener()
  }
}
