import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { acquirePersistenceLease, type PersistenceLease } from '../persistenceLock.js'
import { canonicalWorkspaceIdentity } from '../workspaceLease.js'
import { OutcomeError, type OutcomeReason } from '../outcome.js'
import { checkpointSchema, evidenceRefSchema, evidenceSchema, identitySchema, stateSchema, terminalSchema, turnSchema } from './attemptSchema.js'
import type { LoopAttempt, LoopAttemptStoreOptions, LoopCheckpoint, LoopEvidence, LoopEvidenceRef, LoopState, LoopTerminal } from './types.js'

const maxBytes = 256 * 1024
const decoder = new TextDecoder('utf-8', { fatal: true })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const digest = (value: Buffer): string => createHash('sha256').update(value).digest('hex')

export class LoopIdentityError extends OutcomeError {
  readonly taskId: string
  readonly consumedIterations: number

  constructor(message: string, reason: OutcomeReason, state: Pick<LoopState, 'taskId' | 'consumedIterations'>) {
    super(message, reason)
    this.name = 'LoopIdentityError'
    this.taskId = state.taskId
    this.consumedIterations = state.consumedIterations
  }
}

function recovery(message: string, cause?: unknown): OutcomeError {
  return new OutcomeError(message, { code: 'recovery_required', scope: 'session' }, { cause })
}

function privateFile(path: string, missing = false): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe loop file: ${path}`)
  } catch (error) {
    if (!missing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function directory(path: string): void {
  const stat = lstatSync(path)
  const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalize(realpathSync(path)) !== normalize(resolve(path))) throw new Error(`Unsafe loop directory: ${path}`)
}

function readBytes(path: string): Buffer {
  privateFile(path)
  const before = lstatSync(path)
  const fd = openSync(path, 'r')
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxBytes) throw new Error(`Unsafe or oversized loop file: ${path}`)
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (!count) throw new Error('Loop file changed during read')
      offset += count
    }
    const after = fstatSync(fd)
    privateFile(path)
    const current = lstatSync(path)
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error('Loop file changed during read')
    return bytes
  } finally { closeSync(fd) }
}

function encode(value: unknown): Buffer {
  const bytes = Buffer.from(JSON.stringify(value) + '\n')
  if (bytes.length > maxBytes) throw new Error(`Loop record exceeds ${maxBytes} bytes`)
  return bytes
}

export class LoopAttemptStore {
  private closed = false
  private failure: unknown

  private constructor(private readonly sessionDir: string, private readonly root: string, private readonly lease: PersistenceLease, private state: LoopState) {}

  static async open(options: LoopAttemptStoreOptions): Promise<LoopAttemptStore> {
    let lease: PersistenceLease | undefined
    try {
      if (!isAbsolute(options.sessionDir) || options.sessionDir.includes('\0')) throw new Error('Session directory must be absolute')
      directory(resolve(options.sessionDir))
      const sessionDir = realpathSync(options.sessionDir)
      const root = join(sessionDir, 'loop-controller')
      if (!existsSync(root)) {
        if (options.mode !== 'create') throw new Error('Loop ledger is missing')
        mkdirSync(root, { mode: 0o700 })
      }
      directory(root)
      for (const name of ['evidence', 'attempts']) {
        const path = join(root, name)
        if (!existsSync(path)) {
          if (options.mode !== 'create') throw new Error(`Loop ${name} directory is missing`)
          mkdirSync(path, { mode: 0o700 })
        }
        directory(path)
      }
      const lockRoot = join(root, 'writer.lock.owners')
      if (existsSync(lockRoot)) directory(lockRoot)
      lease = await acquirePersistenceLease(join(root, 'writer'), { signal: options.signal })
      const identity = identitySchema.parse({ ...options.identity, workspace: canonicalWorkspaceIdentity(options.identity.workspace) })
      const path = join(root, 'state.json')
      if (!['create', 'resume'].includes(options.mode)) throw new Error('Unknown loop open mode')
      let state: LoopState
      if (options.mode === 'create') {
        privateFile(path, true)
        if (existsSync(path)) throw new Error('Loop ledger already exists')
        state = stateSchema.parse({ ...identity, schemaVersion: 1, taskId: randomUUID(), revision: 0, maxIterations: options.maxIterations, stagnationLimit: options.stagnationLimit, consumedIterations: 0, stagnation: { count: 0 } })
      } else {
        const raw: unknown = JSON.parse(decoder.decode(readBytes(path)))
        state = stateSchema.parse(raw)
        if (!isDeepStrictEqual(raw, state)) throw new Error('Unexpected loop ledger fields')
        if (state.workspace !== identity.workspace || state.sessionId !== identity.sessionId) throw new LoopIdentityError('Loop workspace or session identity changed', { code: 'recovery_required', scope: 'session' }, state)
        if (state.goalHash !== identity.goalHash || state.definitionHash !== identity.definitionHash) throw new LoopIdentityError('Loop goal or acceptance definition changed', { code: 'acceptance_invalidated' }, state)
      }
      const store = new LoopAttemptStore(sessionDir, root, lease, state)
      store.assertOwned()
      if (options.mode === 'create') store.publish(path, encode(state), () => { if (existsSync(path)) throw new Error('Loop ledger already exists') })
      else store.validateReferences(state)
      return store
    } catch (error) {
      try { lease?.release() } catch {}
      if (error instanceof OutcomeError) throw error
      throw recovery('Cannot open loop ledger; preserve its files for recovery', error)
    }
  }

  snapshot(): LoopState { return clone(this.state) }

  prepare(expectedRevision: number): LoopState {
    this.assertRevision(expectedRevision)
    const current = this.state.current
    if (current && current.phase !== 'checkpointed') throw recovery('Incomplete loop attempt requires recovery before another submission')
    if (current?.checkpoint?.decision.action === 'stop' || this.state.consumedIterations >= this.state.maxIterations) throw new Error('Loop has stopped or exhausted its iteration limit')
    const next = clone(this.state)
    if (current?.checkpoint) next.previousCheckpoint = clone(current.checkpoint)
    next.consumedIterations++
    next.current = { id: randomUUID(), ordinal: next.consumedIterations, phase: 'prepared' }
    return this.commit(next)
  }

  dispatch(attemptId: string, expectedRevision: number, turn: { threadId: string; turnId: string }): LoopState {
    const current = this.attempt(attemptId, expectedRevision)
    const value = turnSchema.parse(turn)
    if (current.turn) {
      if (isDeepStrictEqual(current.turn, value)) return this.snapshot()
      throw recovery('Attempt already binds a different turn')
    }
    if (current.phase !== 'prepared') throw recovery('Attempt cannot dispatch from its current phase')
    const next = clone(this.state)
    Object.assign(next.current!, { phase: 'dispatched', turn: value })
    return this.commit(next)
  }

  settle(attemptId: string, expectedRevision: number, terminal: LoopTerminal): LoopState {
    const current = this.attempt(attemptId, expectedRevision)
    const value = terminalSchema.parse(terminal)
    if (current.terminal) {
      if (isDeepStrictEqual(current.terminal, value)) return this.snapshot()
      throw recovery('Attempt already has a different terminal')
    }
    if (current.phase !== 'dispatched' || current.turn?.threadId !== value.threadId || current.turn.turnId !== value.turnId) throw recovery('Terminal does not match the dispatched attempt')
    const next = clone(this.state)
    Object.assign(next.current!, { phase: 'settled', terminal: value })
    return this.commit(next)
  }

  writeEvidence(attemptId: string, evidence: LoopEvidence): LoopEvidenceRef {
    this.attempt(attemptId, this.state.revision)
    const value = evidenceSchema.parse(evidence)
    const bytes = encode(value)
    const path = `evidence/${attemptId}-${randomUUID()}.json`
    this.publish(join(this.root, path), bytes, () => this.assertRevision(this.state.revision), true)
    return { path, sha256: digest(bytes), bytes: bytes.length, truncated: value.truncated }
  }

  readEvidence(reference: LoopEvidenceRef): LoopEvidence {
    try {
      this.assertDirectories()
      const ref = evidenceRefSchema.parse(reference)
      const bytes = readBytes(join(this.root, ref.path))
      if (bytes.length !== ref.bytes || digest(bytes) !== ref.sha256) throw new Error('Loop evidence digest or size mismatch')
      const raw: unknown = JSON.parse(decoder.decode(bytes))
      const value = evidenceSchema.parse(raw)
      if (!isDeepStrictEqual(raw, value) || value.truncated !== ref.truncated) throw new Error('Invalid loop evidence fields')
      return value
    } catch (error) { throw recovery('Loop evidence is invalid; original files were preserved', error) }
  }

  checkpoint(attemptId: string, expectedRevision: number, value: LoopCheckpoint, assertWorkspaceOwned: () => void): LoopState {
    const current = this.attempt(attemptId, expectedRevision)
    const checked = clone(checkpointSchema.parse(value))
    if (current.phase === 'checkpointed' && isDeepStrictEqual(current.checkpoint, checked)) {
      this.workspaceGuard(assertWorkspaceOwned)
      return this.snapshot()
    }
    if (current.phase !== 'settled') throw recovery('Only a settled attempt can be checkpointed')
    return this.commitCheckpoint(checked, assertWorkspaceOwned)
  }

  revalidate(expectedRevision: number, value: LoopCheckpoint, assertWorkspaceOwned: () => void): LoopState {
    this.assertRevision(expectedRevision)
    const current = this.state.current
    if (current?.phase !== 'checkpointed' || current.checkpoint?.decision.action !== 'stop' || current.checkpoint.decision.status !== 'completed') throw recovery('Revalidation requires a completed checkpoint')
    return this.commitCheckpoint(checkpointSchema.parse(value), assertWorkspaceOwned)
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      try { this.lease.release() } catch (error) { throw recovery('Loop lease could not be released', error) }
    }
  }

  private assertDirectories(): void {
    directory(this.sessionDir)
    for (const path of [this.root, join(this.root, 'evidence'), join(this.root, 'attempts'), join(this.root, 'writer.lock.owners')]) directory(path)
  }

  assertOwned(): void {
    try {
      if (this.closed || this.failure) throw this.failure ?? new Error('Loop store is closed')
      this.assertDirectories()
      this.lease.assertOwned()
    } catch (error) { throw recovery('Loop persistence ownership is unavailable', error) }
  }

  private assertRevision(expectedRevision: number): void {
    this.assertOwned()
    try {
      const raw: unknown = JSON.parse(decoder.decode(readBytes(join(this.root, 'state.json'))))
      if (expectedRevision !== this.state.revision || !isDeepStrictEqual(raw, this.state)) throw new Error('Loop revision or authoritative state changed')
    } catch (error) { throw recovery('Loop revision comparison failed', error) }
  }

  private attempt(attemptId: string, expectedRevision: number): LoopAttempt {
    this.assertRevision(expectedRevision)
    if (this.state.current?.id !== attemptId) throw recovery('Loop attempt identity mismatch')
    return this.state.current
  }

  private workspaceGuard(assertWorkspaceOwned: () => void): void {
    try { assertWorkspaceOwned(); this.assertOwned() } catch (error) { throw recovery('Workspace ownership was lost before loop checkpoint publication', error) }
  }

  private validateCheckpoint(value: LoopCheckpoint, attemptId?: string): void {
    const evidence = this.readEvidence(value.evidence)
    if (attemptId && !value.evidence.path.startsWith(`evidence/${attemptId}-`)) throw recovery('Checkpoint evidence belongs to another attempt')
    if (canonicalWorkspaceIdentity(evidence.workspace) !== this.state.workspace || evidence.definitionHash !== this.state.definitionHash || evidence.artifactVersion !== value.artifactVersion) throw recovery('Checkpoint evidence identity does not match the loop')
    const completed = value.decision.action === 'stop' && value.decision.status === 'completed'
    if (completed && (value.verificationSource !== 'loop' || evidence.status !== 'passed' || evidence.sufficientForCompletion !== true || evidence.outcomeReason || evidence.unfinishedResources?.length || !evidence.commands.length || evidence.commands.some(command => !command.passed || command.exitCode !== 0 || command.cancelled || command.timedOut || command.unfinishedResources?.length) || !value.acceptedAt)) throw recovery('Successful checkpoint lacks complete independent acceptance evidence')
    if (!completed && value.acceptedAt !== undefined) throw recovery('Non-success checkpoint cannot claim acceptance')
  }

  private validateReferences(state: LoopState): void {
    if (state.previousCheckpoint) this.validateCheckpoint(state.previousCheckpoint)
    if (state.current?.checkpoint) this.validateCheckpoint(state.current.checkpoint, state.current.id)
  }

  private commitCheckpoint(value: LoopCheckpoint, assertWorkspaceOwned: () => void): LoopState {
    this.workspaceGuard(assertWorkspaceOwned)
    this.validateCheckpoint(value, this.state.current!.id)
    const next = clone(this.state)
    Object.assign(next.current!, { phase: 'checkpointed', checkpoint: value })
    next.stagnation = clone(value.stagnation)
    return this.commit(next, assertWorkspaceOwned, true)
  }

  private commit(next: LoopState, assertWorkspaceOwned?: () => void, archive = false): LoopState {
    const expectedRevision = this.state.revision
    next.revision++
    const checked = stateSchema.parse(clone(next))
    const bytes = encode(checked)
    const guard = () => {
      this.assertRevision(expectedRevision)
      if (assertWorkspaceOwned) this.workspaceGuard(assertWorkspaceOwned)
      this.validateReferences(checked)
      this.assertRevision(expectedRevision)
    }
    if (archive) {
      const attempt = checked.current!
      this.publish(join(this.root, 'attempts', `${attempt.ordinal}-${attempt.id}-${checked.revision}.json`), bytes, guard, true)
    }
    this.publish(join(this.root, 'state.json'), bytes, guard)
    this.state = checked
    return this.snapshot()
  }

  private publish(path: string, bytes: Buffer, guard: () => void, immutable = false): void {
    const temporary = `${path}.tmp-${randomUUID()}`
    let fd: number | undefined
    try {
      this.assertOwned()
      guard()
      privateFile(path, true)
      if (immutable && existsSync(path)) throw new Error('Immutable loop record already exists')
      fd = openSync(temporary, 'wx', 0o600)
      let offset = 0
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!count) throw new Error('Loop persistence made no progress')
        offset += count
      }
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      guard()
      this.assertOwned()
      privateFile(path, true)
      if (immutable && existsSync(path)) throw new Error('Immutable loop record already exists')
      renameSync(temporary, path)
    } catch (error) {
      this.failure = error
      throw recovery('Loop publication failed or its result is unknown; reopen for recovery', error)
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (!this.failure) { try { unlinkSync(temporary) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
    }
  }
}
