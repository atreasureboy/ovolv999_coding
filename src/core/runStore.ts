import { randomUUID } from 'crypto'
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { basename, join } from 'path'
import { captureProcessIdentitySync, type ProcessIdentity } from './processIdentity.js'
import { durableWrite } from './runtimeState.js'
import { withPersistenceLock } from './persistenceLock.js'

export const MAX_RUN_RECORD_BYTES = 4 * 1024 * 1024
export const MAX_RUN_OPERATIONS = 10_000
const RUN_STATUSES = new Set(['running', 'completed', 'cancelled', 'failed', 'blocked', 'needs_input', 'interrupted', 'limit_reached', 'unknown', 'needs_recovery'])
const RECEIPT_STATUSES = new Set(['completed', 'failed', 'cancelled', 'unknown'])

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
    && RUN_STATUSES.has(String(value.status))
    && validRunOwner(value.owner) && object(value.operations)
}

function validAcceptance(value: unknown): value is NonNullable<RunRecord['acceptance']> {
  return object(value) && text(value.definitionHash, 256) && text(value.artifactVersion, 256)
}

type OperationIntent = Pick<RunRecord['operations'][string], 'name' | 'readOnly' | 'intentAt'> & { receipt?: unknown }

function validOperationIntent(value: unknown): value is OperationIntent {
  return object(value) && text(value.name, 256) && typeof value.readOnly === 'boolean' && timestamp(value.intentAt)
}

function validOperationReceipt(value: unknown): value is NonNullable<RunRecord['operations'][string]['receipt']> {
  return object(value) && typeof value.status === 'string' && RECEIPT_STATUSES.has(value.status) && timestamp(value.recordedAt)
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

function needsRecovery(record: RunRecord): boolean {
  return Object.values(record.operations).some(operation => !operation.receipt || operation.receipt.status === 'unknown')
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
  operations: Record<string, { name: string; readOnly: boolean; intentAt: string; receipt?: { status: string; recordedAt: string } }>
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

  static inspect(path: string): RunRecord {
    const record = readRecord(path)
    if (needsRecovery(record)) record.status = 'needs_recovery'
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

  intent(name: string, readOnly: boolean): string {
    if (!text(name, 256) || typeof readOnly !== 'boolean') throw new Error('Invalid operation intent')
    const id = randomUUID()
    this.update(record => { record.operations[id] = { name, readOnly, intentAt: new Date().toISOString() } })
    return id
  }

  receipt(id: string, status: string): void {
    if (!identity(id) || !RECEIPT_STATUSES.has(status)) throw new Error('Invalid operation receipt')
    this.update(record => {
      const operation = record.operations[id]
      if (!Object.hasOwn(record.operations, id) || !operation || operation.receipt) throw new Error('Unknown or already settled operation')
      operation.receipt = { status, recordedAt: new Date().toISOString() }
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
