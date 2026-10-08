import { randomUUID } from 'crypto'
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { join, resolve } from 'path'
import { captureProcessIdentitySync, inspectProcessIdentitySync, type ProcessIdentity } from './processIdentity.js'
import { withPersistenceLock } from './persistenceLock.js'
import { durableWrite } from './runtimeState.js'
import type { WorktreeArtifact, WorktreeInfo } from '../tools/worktree.js'

export interface StoredWorktreeAcceptance {
  generation: string
  definitionHash: string
  definitionContext: string
  artifactVersion: string
  targetCommit: string
  artifact: WorktreeArtifact
}

export interface StoredWorktree {
  info: WorktreeInfo
  generation: string
  acceptance?: StoredWorktreeAcceptance
  operation?: {
    kind: 'create' | 'merge' | 'discard'
    phase: 'intent' | 'merged' | 'removing' | 'removed'
    commit?: string
    artifact?: WorktreeArtifact
    deleteBranch?: boolean
  }
}

export interface WorktreeStoreRecord {
  schemaVersion: 1
  repositoryPath: string
  owner: ProcessIdentity
  epoch: string
  revision: number
  worktrees: StoredWorktree[]
}

const MAX_BYTES = 4 * 1024 * 1024

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 32768
}

function validInfo(value: unknown): value is WorktreeInfo {
  return object(value) && ['name', 'path', 'branch', 'baseBranch', 'createdAt'].every(key => text(value[key]))
    && ['baseCommit', 'targetBranch', 'targetCommit', 'repositoryPath'].every(key => value[key] === undefined || text(value[key]))
}

function validArtifact(value: unknown): value is WorktreeArtifact {
  return object(value) && text(value.commit) && text(value.diff) && object(value.workspace)
    && ['cwd', 'repositoryPath', 'worktreeName', 'baseCommit', 'targetBranch', 'targetCommit', 'branch'].every(key => text(value.workspace && (value.workspace as Record<string, unknown>)[key]))
}

function validOperation(value: unknown): boolean {
  if (!object(value) || typeof value.kind !== 'string' || !['create', 'merge', 'discard'].includes(value.kind)
    || typeof value.phase !== 'string' || !['intent', 'merged', 'removing', 'removed'].includes(value.phase)
    || (value.deleteBranch !== undefined && typeof value.deleteBranch !== 'boolean')) return false
  if (value.kind === 'create') return value.phase === 'intent' && value.commit === undefined && value.artifact === undefined && value.deleteBranch === undefined
  if (!text(value.commit)) return false
  if (value.kind === 'discard') return value.phase !== 'merged' && value.artifact === undefined
  return validArtifact(value.artifact) && value.commit === value.artifact.commit
}

function validateEntries(value: unknown): asserts value is StoredWorktree[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Corrupt worktree entries; preserve metadata for recovery')
  const names = new Set<string>()
  const paths = new Set<string>()
  for (const entry of value) {
    if (!object(entry) || !validInfo(entry.info) || !text(entry.generation) || names.has(entry.info.name) || paths.has(resolve(entry.info.path))) throw new Error('Corrupt worktree identity; preserve metadata for recovery')
    names.add(entry.info.name)
    paths.add(resolve(entry.info.path))
    const acceptance = entry.acceptance
    if (acceptance !== undefined && (!object(acceptance) || !['generation', 'definitionHash', 'definitionContext', 'artifactVersion', 'targetCommit'].every(key => text(acceptance[key])) || !validArtifact(acceptance.artifact) || acceptance.generation !== entry.generation || acceptance.targetCommit !== entry.info.targetCommit)) throw new Error('Corrupt worktree acceptance; preserve metadata for recovery')
    const operation = entry.operation
    if (operation !== undefined && !validOperation(operation)) throw new Error('Corrupt worktree operation; preserve metadata for recovery')
  }
}

function sameOwner(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return a.pid === b.pid && a.hostname === b.hostname && a.birthId === b.birthId
}

function read(path: string, repositoryPath: string, owner: ProcessIdentity): WorktreeStoreRecord | undefined {
  try {
    const fd = openSync(path, 'r')
    let raw: string
    try {
      const size = fstatSync(fd).size
      if (size > MAX_BYTES) throw new Error('Worktree metadata size limit exceeded; preserve for recovery')
      const buffer = Buffer.alloc(size + 1)
      let total = 0
      while (total < buffer.length) {
        const count = readSync(fd, buffer, total, buffer.length - total, total)
        if (!count) break
        total += count
      }
      if (total > size) throw new Error('Worktree metadata changed while reading; retry inspection')
      raw = buffer.subarray(0, total).toString('utf8')
    } finally { closeSync(fd) }
    const value: unknown = JSON.parse(raw)
    if (Array.isArray(value)) {
      if (!value.every(validInfo)) throw new Error('Invalid legacy metadata')
      const worktrees = value.map(info => ({ info, generation: 'legacy' }))
      validateEntries(worktrees)
      return { schemaVersion: 1, repositoryPath, owner, epoch: 'legacy', revision: 0, worktrees }
    }
    if (!object(value) || value.schemaVersion !== 1 || value.repositoryPath !== repositoryPath || !object(value.owner) || !Number.isInteger(value.owner.pid) || Number(value.owner.pid) <= 0 || !text(value.owner.hostname) || !text(value.owner.birthId) || !text(value.epoch) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new Error('Invalid record')
    validateEntries(value.worktrees)
    return value as unknown as WorktreeStoreRecord
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`Unsupported or corrupt worktree metadata at ${path}; preserve for recovery: ${(error as Error).message}`, { cause: error })
  }
}

export class WorktreeStore {
  readonly path: string
  private record: WorktreeStoreRecord
  private present: boolean

  constructor(readonly repositoryPath: string) {
    this.repositoryPath = resolve(repositoryPath)
    this.path = join(this.repositoryPath, '.ovolv999', 'worktrees.json')
    const owner = captureProcessIdentitySync()
    if (!owner) throw new Error('Worktree owner identity cannot be verified')
    const disk = read(this.path, this.repositoryPath, owner)
    this.present = !!disk
    this.record = disk ?? { schemaVersion: 1, repositoryPath: this.repositoryPath, owner, epoch: randomUUID(), revision: 0, worktrees: [] }
  }

  snapshot(): WorktreeStoreRecord {
    return structuredClone(this.record)
  }

  transaction<T>(action: (record: WorktreeStoreRecord, commit: () => void, assertOwned: () => void) => T): T {
    return withPersistenceLock(this.path, () => {
      const owner = captureProcessIdentitySync()
      if (!owner) throw new Error('Worktree owner identity cannot be verified')
      const assertOwned = () => {
        const disk = read(this.path, this.repositoryPath, owner)
        if (this.present !== !!disk || (disk && (disk.epoch !== this.record.epoch || disk.revision !== this.record.revision || !sameOwner(disk.owner, this.record.owner)))) throw new Error('Worktree ownership or revision changed; mutation rejected and files retained')
      }
      assertOwned()
      const next = structuredClone(this.record)
      const commit = () => {
        assertOwned()
        validateEntries(next.worktrees)
        if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error('Worktree metadata size limit exceeded; write was not committed')
        next.revision++
        durableWrite(this.path, next)
        this.record = structuredClone(next)
        this.present = true
        assertOwned()
      }
      if (!sameOwner(next.owner, owner)) {
        const status = inspectProcessIdentitySync(next.owner)
        if (status !== 'dead' && status !== 'mismatch') throw new Error('Worktree metadata has a live or unverified owner; files retained')
        next.owner = owner
        next.epoch = randomUUID()
        commit()
      } else if (next.epoch === 'legacy') {
        next.epoch = randomUUID()
      }
      return action(next, commit, assertOwned)
    })
  }
}
