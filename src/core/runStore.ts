import { randomUUID } from 'crypto'
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { basename, join, resolve } from 'path'
import { captureProcessIdentitySync, inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'
import { durableWrite } from './runtimeState.js'
import { withPersistenceLock, withPersistenceLockAsync } from './persistenceLock.js'

export const MAX_RUN_RECORD_BYTES = 4 * 1024 * 1024
export const MAX_RUN_OPERATIONS = 10_000
const RUN_STATUSES = new Set(['running', 'completed', 'cancelled', 'failed', 'blocked', 'needs_input', 'interrupted', 'limit_reached', 'unknown', 'needs_recovery'])
const RECEIPT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unknown'])
const EFFECT_STATUSES = new Set(['not_started', 'observed_applied', 'unknown', 'read_only'])
const MAX_OPERATION_REFERENCES = 128
const MAX_FILE_OBSERVATIONS = 32
const MAX_RECONCILIATIONS = 256

export type OperationEffects = 'not_started' | 'observed_applied' | 'unknown' | 'read_only'

export interface OperationMetadata {
  inputDigest: string
  workspace: string
  affectedPaths: string[]
  resourceIds: string[]
  summary?: string
}

export interface OperationFileEvidence {
  kind: 'builtin-file'
  path: string
  canonicalPath: string
  beforeHash: string | null
  expectedHash: string
  completion: 'write-only' | 'format-pending'
}

export interface OperationFileObservation {
  canonicalPath: string
  hash: string
  final: boolean
}

export interface OperationReconciliation {
  receiptId: string
  decision: 'keep' | 'cancel' | 'continue'
  status: 'completed' | 'cancelled' | 'needs_recovery'
  effects: OperationEffects
  reason: string
  recordedAt: string
  owner: ProcessIdentity
  epoch: string
  revision: number
  observedHash?: string
}

export interface RunOperation {
  name: string
  readOnly: boolean
  intentAt: string
  inputDigest?: string
  workspace?: string
  affectedPaths?: string[]
  resourceIds?: string[]
  summary?: string
  fileEvidence?: OperationFileEvidence
  fileObservations?: Array<OperationFileObservation & { recordedAt: string }>
  receipt?: { status: string; recordedAt: string; effects?: OperationEffects }
  reconciliations?: OperationReconciliation[]
}

export interface OperationRecoveryOptions {
  expectedEpoch: string
  expectedRevision: number
  physicalStopConfirmed: boolean
  decision: 'keep' | 'cancel' | 'continue'
}

export type OperationSettlement = Pick<OperationReconciliation, 'status' | 'effects' | 'reason' | 'observedHash'>

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= limit
}

function identity(value: unknown): value is string {
  return text(value, 128) && /^[a-zA-Z0-9][\w-]*$/.test(value) && !['constructor', 'prototype'].includes(value)
}

function timestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}

function validRunOwner(value: unknown): value is ProcessIdentity {
  return object(value)
    && Number.isInteger(value.pid) && Number(value.pid) > 0
    && text(value.hostname, 255) && text(value.birthId, 256)
}

function validRunMetadata(value: Record<string, unknown>, path: string): boolean {
  return value.schemaVersion === 1
    && identity(value.runId) && basename(path) === value.runId + '.json'
    && (value.parentRunId === undefined || identity(value.parentRunId))
    && text(value.workspace, 32768) && text(value.epoch, 128)
    && Number.isSafeInteger(value.revision) && Number(value.revision) >= 0
    && typeof value.status === 'string' && RUN_STATUSES.has(value.status)
    && validRunOwner(value.owner) && object(value.operations)
}

function validAcceptance(value: unknown): value is NonNullable<RunRecord['acceptance']> {
  return object(value) && text(value.definitionHash, 256) && text(value.artifactVersion, 256)
}

function digest(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

function references(value: unknown, maxLength: number): value is string[] {
  return Array.isArray(value) && value.length <= MAX_OPERATION_REFERENCES && value.every(entry => text(entry, maxLength))
}

function validOperationMetadata(value: Record<string, unknown>): boolean {
  const fields = ['inputDigest', 'workspace', 'affectedPaths', 'resourceIds', 'summary']
  if (!fields.some(field => Object.hasOwn(value, field))) return true
  return digest(value.inputDigest) && text(value.workspace, 32768)
    && references(value.affectedPaths, 32768) && references(value.resourceIds, 256)
    && (value.summary === undefined || text(value.summary, 1024))
}

function validFileEvidence(value: unknown): value is OperationFileEvidence {
  return object(value) && value.kind === 'builtin-file' && text(value.path, 32768)
    && text(value.canonicalPath, 32768) && (value.beforeHash === null || digest(value.beforeHash))
    && digest(value.expectedHash) && typeof value.completion === 'string' && ['write-only', 'format-pending'].includes(value.completion)
}

function validFileObservation(value: unknown): boolean {
  return object(value) && text(value.canonicalPath, 32768) && digest(value.hash)
    && typeof value.final === 'boolean' && timestamp(value.recordedAt)
}

function validReconciliation(value: unknown): boolean {
  return object(value) && identity(value.receiptId) && typeof value.decision === 'string' && ['keep', 'cancel', 'continue'].includes(value.decision)
    && typeof value.status === 'string' && ['completed', 'cancelled', 'needs_recovery'].includes(value.status)
    && typeof value.effects === 'string' && EFFECT_STATUSES.has(value.effects) && text(value.reason, 2048) && timestamp(value.recordedAt)
    && validRunOwner(value.owner) && text(value.epoch, 128)
    && Number.isSafeInteger(value.revision) && Number(value.revision) > 0
    && (value.observedHash === undefined || digest(value.observedHash))
    && (value.decision !== 'keep' || value.status === 'needs_recovery')
    && (value.decision !== 'cancel' || value.status === 'cancelled')
    && (value.decision !== 'continue' || value.status !== 'cancelled')
}

function validOperationIntent(value: unknown): value is RunOperation {
  return object(value) && text(value.name, 256) && typeof value.readOnly === 'boolean' && timestamp(value.intentAt)
    && validOperationMetadata(value)
    && (value.fileEvidence === undefined || (validFileEvidence(value.fileEvidence) && value.readOnly === false && digest(value.inputDigest)))
    && (value.fileObservations === undefined || (value.fileEvidence !== undefined && Array.isArray(value.fileObservations) && value.fileObservations.length <= MAX_FILE_OBSERVATIONS && value.fileObservations.every(validFileObservation)))
    && (value.reconciliations === undefined || (Array.isArray(value.reconciliations) && value.reconciliations.length <= MAX_RECONCILIATIONS && value.reconciliations.every(validReconciliation)))
}

function validOperationReceipt(value: unknown): value is NonNullable<RunRecord['operations'][string]['receipt']> {
  return object(value) && typeof value.status === 'string' && RECEIPT_STATUSES.has(value.status) && timestamp(value.recordedAt)
    && (value.effects === undefined || (typeof value.effects === 'string' && EFFECT_STATUSES.has(value.effects)))
}

function validate(value: unknown, path: string): asserts value is RunRecord {
  const fail = (): never => { throw new Error(`Unsupported or corrupt RunStore: ${path}; preserve for recovery`) }
  if (!object(value) || !validRunMetadata(value, path)) fail()
  const record = value as RunRecord
  if (record.acceptance !== undefined && !validAcceptance(record.acceptance)) fail()
  const operations = Object.entries(record.operations)
  if (operations.length > MAX_RUN_OPERATIONS) throw new Error(`RunStore operation limit exceeded at ${path}; preserve for recovery`)
  for (const [id, operation] of operations) {
    if (!identity(id) || !validOperationIntent(operation)) fail()
    if (operation.receipt !== undefined && !validOperationReceipt(operation.receipt)) fail()
  }
}

function readRecord(path: string): RunRecord {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    if (size > MAX_RUN_RECORD_BYTES) throw new Error(`RunStore size limit exceeded at ${path}; preserve for recovery`)
    const buffer = Buffer.alloc(Math.min(MAX_RUN_RECORD_BYTES + 1, size + 1))
    let total = 0
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, total)
      if (!count) break
      total += count
    }
    if (total > size) throw new Error(`RunStore changed size while reading ${path}; retry inspection`)
    let record: unknown
    try { record = JSON.parse(buffer.subarray(0, total).toString('utf8')) } catch (error) { throw new Error(`Corrupt RunStore JSON at ${path}; preserve for recovery`, { cause: error }) }
    validate(record, path)
    return record
  } finally { closeSync(fd) }
}

export function operationNeedsRecovery(operation: RunOperation): boolean {
  const last = operation.reconciliations?.at(-1)
  if (last) return last.status === 'needs_recovery'
  return !operation.receipt || operation.receipt.status === 'unknown' || operation.receipt.effects === 'unknown'
}

function needsRecovery(record: RunRecord): boolean {
  return Object.values(record.operations).some(operationNeedsRecovery)
}

function writeRecord(path: string, record: RunRecord, exclusive = false): void {
  validate(record, path)
  if (Buffer.byteLength(JSON.stringify(record), 'utf8') > MAX_RUN_RECORD_BYTES) throw new Error(`RunStore size limit exceeded at ${path}; write was not committed`)
  durableWrite(path, record, exclusive)
}

export interface RunRecord {
  schemaVersion: 1
  runId: string
  parentRunId?: string
  workspace: string
  owner: ProcessIdentity
  epoch: string
  revision: number
  status: string
  acceptance?: { definitionHash: string; artifactVersion: string }
  operations: Record<string, RunOperation>
}

export class RunStore {
  readonly path: string
  private record: RunRecord

  constructor(root: string, identity: { runId: string; parentRunId?: string; workspace: string }) {
    if (!text(identity.runId, 128) || !/^[a-zA-Z0-9][\w-]*$/.test(identity.runId)) throw new Error('Invalid run identity')
    const owner = captureProcessIdentitySync()
    if (!owner) throw new Error('Run owner identity cannot be verified')
    this.path = join(root, 'runs', identity.runId + '.json')
    this.record = { schemaVersion: 1, ...identity, owner, epoch: randomUUID(), revision: 0, status: 'running', operations: {} }
    writeRecord(this.path, this.record, true)
  }

  static inspect(path: string, options: { deriveStatus?: boolean } = {}): RunRecord {
    const record = readRecord(path)
    if (options.deriveStatus !== false && needsRecovery(record)) record.status = 'needs_recovery'
    return record
  }

  private update(action: (record: RunRecord) => void): void {
    withPersistenceLock(this.path, () => {
      const disk = readRecord(this.path)
      if (disk.epoch !== this.record.epoch || disk.revision !== this.record.revision || disk.owner.pid !== this.record.owner.pid || disk.owner.hostname !== this.record.owner.hostname || disk.owner.birthId !== this.record.owner.birthId) throw new Error('RunStore ownership or revision changed; result rejected')
      const next = structuredClone(this.record)
      action(next)
      next.revision++
      writeRecord(this.path, next)
      this.record = next
    })
  }

  intent(name: string, readOnly: boolean, metadata?: OperationMetadata): string {
    if (!text(name, 256) || typeof readOnly !== 'boolean') throw new Error('Invalid operation intent')
    if (metadata && (!validOperationMetadata(metadata as unknown as Record<string, unknown>) || resolve(metadata.workspace) !== resolve(this.record.workspace))) throw new Error('Invalid operation metadata')
    const id = randomUUID()
    const details = metadata ? structuredClone({ inputDigest: metadata.inputDigest, workspace: metadata.workspace, affectedPaths: metadata.affectedPaths, resourceIds: metadata.resourceIds, summary: metadata.summary ?? `${name}; ${metadata.affectedPaths.length} affected paths; ${metadata.resourceIds.length} resources` }) : undefined
    this.update(record => { record.operations[id] = { name, readOnly, intentAt: new Date().toISOString(), ...details } })
    return id
  }

  receipt(id: string, status: string, effects?: OperationEffects): void {
    if (!identity(id) || !RECEIPT_STATUSES.has(status) || (effects !== undefined && !EFFECT_STATUSES.has(effects))) throw new Error('Invalid operation receipt')
    this.update(record => {
      const operation = record.operations[id]
      if (!Object.hasOwn(record.operations, id) || !operation || operation.receipt) throw new Error('Unknown or already settled operation')
      operation.receipt = { status, recordedAt: new Date().toISOString(), ...(effects === undefined ? {} : { effects }) }
    })
  }

  bindResources(id: string, resourceIds: string[]): void {
    if (!references(resourceIds, 256)) throw new Error('Invalid operation resources')
    this.update(record => {
      const operation = this.mutableOperation(record, id)
      if (!operation.inputDigest) throw new Error('Operation metadata is required before binding resources')
      operation.resourceIds = [...new Set([...(operation.resourceIds ?? []), ...resourceIds])]
    })
  }

  recordFileEvidence(id: string, evidence: OperationFileEvidence): void {
    if (!validFileEvidence(evidence)) throw new Error('Invalid file evidence')
    this.update(record => {
      const operation = this.mutableOperation(record, id)
      if (operation.readOnly || !operation.inputDigest || operation.fileEvidence) throw new Error('File evidence is unavailable or already recorded')
      operation.fileEvidence = { kind: evidence.kind, path: evidence.path, canonicalPath: evidence.canonicalPath, beforeHash: evidence.beforeHash, expectedHash: evidence.expectedHash, completion: evidence.completion }
    })
  }

  recordFileObservation(id: string, observation: OperationFileObservation): void {
    const value = { canonicalPath: observation.canonicalPath, hash: observation.hash, final: observation.final, recordedAt: new Date().toISOString() }
    if (!validFileObservation(value)) throw new Error('Invalid file observation')
    this.update(record => {
      const operation = this.mutableOperation(record, id)
      if (!operation.fileEvidence || observation.canonicalPath !== operation.fileEvidence.canonicalPath) throw new Error('File observation target does not match trusted evidence')
      operation.fileObservations ??= []
      operation.fileObservations.push(structuredClone(value))
    })
  }

  private mutableOperation(record: RunRecord, id: string): RunOperation {
    const operation = record.operations[id]
    if (!identity(id) || !Object.hasOwn(record.operations, id) || !operation || operation.receipt || operation.reconciliations?.length) throw new Error('Unknown or already settled operation')
    return operation
  }

  static async appendReconciliation(path: string, id: string, options: OperationRecoveryOptions, settle: (operation: RunOperation) => OperationSettlement | Promise<OperationSettlement>): Promise<OperationReconciliation> {
    if (!identity(id) || !text(options.expectedEpoch, 128) || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || !['keep', 'cancel', 'continue'].includes(options.decision)) throw new Error('Invalid operation recovery request')
    if (!options.physicalStopConfirmed) throw new Error('Physical resource stop must be confirmed before operation reconciliation')
    return withPersistenceLockAsync(path, async () => {
      const record = readRecord(path)
      if (record.epoch !== options.expectedEpoch || record.revision !== options.expectedRevision) throw new Error('RunStore recovery epoch or revision changed; result rejected')
      const status = await inspectProcessIdentity(record.owner)
      if (status === 'matching' || status === 'unknown') throw new Error('Run owner is alive or unverified; cannot reconcile operation')
      const operation = record.operations[id]
      if (!Object.hasOwn(record.operations, id) || !operation || !operationNeedsRecovery(operation)) throw new Error('Unknown or already settled operation')
      const settlement = await settle(structuredClone(operation))
      const current = readRecord(path)
      if (JSON.stringify(current) !== JSON.stringify(record)) throw new Error('RunStore recovery ownership or revision changed; result rejected')
      const owner = captureProcessIdentitySync()
      if (!owner) throw new Error('Recovery owner identity cannot be verified')
      const receipt: OperationReconciliation = { ...settlement, receiptId: randomUUID(), decision: options.decision, recordedAt: new Date().toISOString(), owner, epoch: record.epoch, revision: record.revision + 1 }
      operation.reconciliations ??= []
      operation.reconciliations.push(receipt)
      record.revision++
      record.status = needsRecovery(record) ? 'needs_recovery' : options.decision === 'cancel' ? 'cancelled' : 'interrupted'
      writeRecord(path, record)
      return structuredClone(receipt)
    })
  }

  acceptance(definitionHash: string, artifactVersion: string): void {
    this.update(record => { record.acceptance = { definitionHash, artifactVersion } })
  }

  finish(status: string): void {
    if (!RUN_STATUSES.has(status)) throw new Error('Invalid run status')
    this.update(record => { record.status = needsRecovery(record) ? 'needs_recovery' : status })
  }
}
