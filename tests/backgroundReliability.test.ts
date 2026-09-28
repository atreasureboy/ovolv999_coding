import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { attachToSession, cleanStaleSessions, generateSessionId, getLogPath, getMetadataPath, loadMetadata, readSessionLogs, saveMetadata, updateMetadata } from '../src/core/backgroundSession.js'

let home: string
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ovogo-bg-reliability-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

function session(status: 'running' | 'completed' | 'unknown' = 'running') {
  const id = generateSessionId()
  saveMetadata({ id, task: 'test', cwd: home, pid: status === 'completed' ? null : process.pid, status, startedAt: '2000-01-01T00:00:00Z', logPath: getLogPath(id) })
  writeFileSync(getLogPath(id), '')
  return id
}

describe('background durable metadata and bounded observation', () => {
  it('rejects stale metadata writers without overwriting the latest state', () => {
    const id = session()
    const stale = loadMetadata(id)!
    updateMetadata(id, { task: 'new task' })
    expect(() => saveMetadata({ ...stale, task: 'lost update' })).toThrow(/revision|conflict/i)
    expect(loadMetadata(id)?.task).toBe('new task')
  })

  it('rejects corrupt and future metadata without replacing evidence', () => {
    const id = session()
    const original = JSON.parse(readFileSync(getMetadataPath(id), 'utf8'))
    writeFileSync(getMetadataPath(id), JSON.stringify({ ...original, schemaVersion: 999 }))
    expect(() => updateMetadata(id, { task: 'overwrite' })).toThrow(/version/i)
    expect(JSON.parse(readFileSync(getMetadataPath(id), 'utf8')).schemaVersion).toBe(999)
  })

  it('preserves unknown live sessions during cleanup', () => {
    const id = session('unknown')
    expect(cleanStaleSessions()).toBe(0)
    expect(existsSync(getMetadataPath(id))).toBe(true)
  })

  it('ends attachment to a terminal session without waiting forever', async () => {
    const handle = attachToSession(session('completed'), 5)!
    try {
      const result = await Promise.race([handle.stream[Symbol.asyncIterator]().next(), delay(100).then(() => 'timeout')])
      expect(result).toEqual({ value: undefined, done: true })
    } finally { handle.stop() }
  })

  it('settles pending next when the consumer returns', async () => {
    const handle = attachToSession(session(), 5)!
    const iterator = handle.stream[Symbol.asyncIterator]()
    const pending = iterator.next()
    await iterator.return!()
    const result = await Promise.race([pending, delay(100).then(() => 'timeout')])
    handle.stop()
    expect(result).toEqual({ value: undefined, done: true })
  })

  it('preserves partial Unicode lines across polls and observes rotation', async () => {
    const id = session()
    const handle = attachToSession(id, 5)!
    const iterator = handle.stream[Symbol.asyncIterator]()
    try {
      const bytes = Buffer.from('你好\n')
      appendFileSync(getLogPath(id), bytes.subarray(0, 2))
      await delay(30)
      appendFileSync(getLogPath(id), bytes.subarray(2))
      expect(await iterator.next()).toEqual({ value: '你好', done: false })
      renameSync(getLogPath(id), `${getLogPath(id)}.1`)
      writeFileSync(getLogPath(id), 'rotated\n')
      expect(await iterator.next()).toEqual({ value: 'rotated', done: false })
    } finally { handle.stop() }
  })

  it('caps range reads explicitly and refuses silent truncation', () => {
    const id = session()
    writeFileSync(getLogPath(id), 'a'.repeat(2 * 1024 * 1024))
    expect(() => readSessionLogs(id, { startOffset: 0 })).toThrow(/limit|large|bytes/i)
    expect(readSessionLogs(id, { startOffset: 2 * 1024 * 1024 - 10 })).toBe('a'.repeat(10))
  })

  it('fails a slow consumer explicitly instead of buffering an unlimited queue', async () => {
    const id = session()
    const handle = attachToSession(id, 5, { maxQueueBytes: 32, maxQueueLines: 2 })!
    try {
      appendFileSync(getLogPath(id), 'first\nsecond\nthird\n')
      await delay(30)
      await expect(handle.stream[Symbol.asyncIterator]().next()).rejects.toThrow(/queue limit/i)
    } finally { handle.stop() }
  })

  it('continues after truncation and flushes a final partial line before EOF', async () => {
    const id = session()
    writeFileSync(getLogPath(id), 'previous long log\n')
    const handle = attachToSession(id, 5)!
    const iterator = handle.stream[Symbol.asyncIterator]()
    try {
      writeFileSync(getLogPath(id), 'new\n')
      expect(await iterator.next()).toEqual({ value: 'new', done: false })
      appendFileSync(getLogPath(id), 'final')
      updateMetadata(id, { status: 'completed', pid: null })
      expect(await iterator.next()).toEqual({ value: 'final', done: false })
      expect(await iterator.next()).toEqual({ value: undefined, done: true })
    } finally { handle.stop() }
  })

  it('retains a split Unicode character while following the rotated file', async () => {
    const id = session()
    const handle = attachToSession(id, 5)!
    try {
      const bytes = Buffer.from('好\n')
      appendFileSync(getLogPath(id), bytes.subarray(0, 1))
      await delay(25)
      renameSync(getLogPath(id), `${getLogPath(id)}.1`)
      writeFileSync(getLogPath(id), bytes.subarray(1))
      expect(await handle.stream[Symbol.asyncIterator]().next()).toEqual({ value: '好', done: false })
    } finally { handle.stop() }
  })
})
