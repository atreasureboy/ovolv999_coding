import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { eventText, eventVerification } from './engine/events.js'
import { validateSessionMessages } from './sessionManager.js'
import type { OpenAIMessage, TurnResult } from './types.js'
import { trimHistoryForNextTurn } from '../ui/historyTrimmer.js'

const MAX_MODEL_WINDOW_BYTES = 8 * 1024 * 1024
const MAX_TURN_RESULT_BYTES = 4 * 1024 * 1024
const MAX_TERMINAL_RESULT_BYTES = 64 * 1024
const PROJECTION_FILE = 'agent-model-window.json'
const decoder = new TextDecoder('utf-8', { fatal: true })

function projectionPayload(revision: number, messages: OpenAIMessage[]): string {
  return JSON.stringify({ version: 1, historyRevision: revision, messages })
}

function projectionBytes(messages: OpenAIMessage[]): number {
  return Buffer.byteLength(projectionPayload(Number.MAX_SAFE_INTEGER, messages), 'utf8')
}

function privateFile(path: string, allowMissing = false): void {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error(`Unsafe service data file: ${path}`)
  } catch (error) {
    if (!allowMissing || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function writePrivateJson(path: string, payload: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== resolve(directory)) throw new Error('Unsafe service data directory')
  privateFile(path, true)
  const temporary = `${path}.tmp-${randomUUID()}`
  let fd: number | undefined
  try {
    fd = openSync(temporary, 'wx', 0o600)
    const bytes = Buffer.from(payload, 'utf8')
    let offset = 0
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset)
      if (!written) throw new Error('Service data persistence made no progress')
      offset += written
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    privateFile(path, true)
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    try { unlinkSync(temporary) } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'Service data persistence and cleanup failed', { cause: cleanupError })
    }
    throw error
  }
}

export function prepareModelWindow(messages: OpenAIMessage[], reset = false): OpenAIMessage[] {
  validateSessionMessages(messages)
  let projection = structuredClone(messages)
  if (reset || projectionBytes(projection) > MAX_MODEL_WINDOW_BYTES) {
    projection = projection.map(message => {
      delete message.providerState
      return message
    })
  }
  if (!projection.some(message => message.providerState !== undefined)) projection = trimHistoryForNextTurn(projection)
  while (projectionBytes(projection) > MAX_MODEL_WINDOW_BYTES) {
    projection.shift()
    while (projection[0]?.role === 'tool') projection.shift()
  }
  return projection
}

export function readModelWindow(sessionDir: string, revision: number, canonical: OpenAIMessage[]): OpenAIMessage[] {
  const fallback = () => prepareModelWindow(canonical, true)
  const path = join(sessionDir, PROJECTION_FILE)
  let fd: number | undefined
  try {
    privateFile(path)
    const prior = lstatSync(path)
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== prior.dev || opened.ino !== prior.ino) throw new Error('Model window projection changed while opening')
    if (opened.size > MAX_MODEL_WINDOW_BYTES) return fallback()
    const bytes = Buffer.alloc(MAX_MODEL_WINDOW_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, length)
      if (!read) break
      length += read
    }
    if (length > MAX_MODEL_WINDOW_BYTES) return fallback()
    let parsed: unknown
    try { parsed = JSON.parse(decoder.decode(bytes.subarray(0, length))) as unknown } catch { return fallback() }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback()
    const value = parsed as { version?: unknown; historyRevision?: unknown; messages?: unknown }
    if (value.version !== 1 || value.historyRevision !== revision) return fallback()
    try { validateSessionMessages(value.messages) } catch { return fallback() }
    return prepareModelWindow(value.messages)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback()
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export function saveModelWindow(sessionDir: string, revision: number, messages: OpenAIMessage[]): Promise<void> {
  validateSessionMessages(messages)
  const payload = projectionPayload(revision, messages)
  if (Buffer.byteLength(payload, 'utf8') > MAX_MODEL_WINDOW_BYTES) throw new Error('Model window projection exceeds its durable capacity')
  writePrivateJson(join(sessionDir, PROJECTION_FILE), payload)
  return Promise.resolve()
}

export function saveTurnResult(sessionDir: string, turnId: string, result: TurnResult): Promise<{ result: TurnResult; truncated?: boolean; artifact?: string }> {
  const payload = JSON.stringify(result)
  if (Buffer.byteLength(payload, 'utf8') <= MAX_TERMINAL_RESULT_BYTES) return Promise.resolve({ result })
  if (Buffer.byteLength(payload, 'utf8') > MAX_TURN_RESULT_BYTES) throw new Error('Turn result exceeds its durable artifact capacity')
  if (!/^[a-f0-9-]{36}$/.test(turnId)) throw new Error('Invalid turn result identity')
  const artifact = `agent-results/${turnId}.json`
  writePrivateJson(join(sessionDir, artifact), payload)
  const bounded: TurnResult = {
    ...result,
    output: eventText(result.output, 16 * 1024).text,
    ...(result.unfinishedResources ? { unfinishedResources: result.unfinishedResources.slice(0, 32).map(value => eventText(value, 256).text) } : {}),
    ...(result.verification ? { verification: eventVerification(result.verification).verification } : {}),
  }
  if (Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_TERMINAL_RESULT_BYTES) throw new Error('Turn terminal result exceeds its event capacity')
  return Promise.resolve({ result: bounded, truncated: true, artifact })
}
