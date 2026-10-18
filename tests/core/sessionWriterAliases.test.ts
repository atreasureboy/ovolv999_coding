import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimSessionOwnership, loadSession, readSessionSnapshot, releaseSessionOwnership, saveSession } from '../../src/core/sessionManager.js'
import { acquirePersistenceLeaseSync } from '../../src/core/persistenceLock.js'

const directories: string[] = []
const claimed: string[] = []
afterEach(() => {
  for (const directory of claimed.splice(0)) releaseSessionOwnership(directory)
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it.each([false, true])('reuses and releases one writer through a junction with missing child=%s', missing => {
  const base = mkdtempSync(join(tmpdir(), 'ovo-session-alias-'))
  directories.push(base)
  const canonical = join(base, 'canonical')
  const alias = join(base, 'alias')
  mkdirSync(canonical)
  symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const actual = missing ? join(canonical, 'new', 'session') : canonical
  const requested = missing ? join(alias, 'new', 'session') : alias
  claimed.push(requested, actual)
  const identity = readSessionSnapshot(requested).sessionId
  claimSessionOwnership(requested)
  expect(() => claimSessionOwnership(actual)).not.toThrow()
  saveSession(actual, [{ role: 'user', content: 'saved through canonical path' }])
  expect(loadSession(requested)).toEqual([{ role: 'user', content: 'saved through canonical path' }])
  expect(readSessionSnapshot(actual).sessionId).toBe(identity)
  releaseSessionOwnership(actual)
  const independent = acquirePersistenceLeaseSync(join(requested, 'writer'))
  try { expect(() => claimSessionOwnership(requested)).toThrow(/owned|busy/i) } finally { independent.release() }
  claimSessionOwnership(actual)
  releaseSessionOwnership(requested)
  const reacquired = acquirePersistenceLeaseSync(join(actual, 'writer'))
  reacquired.release()
})

it('detects stale revisions observed through an alias before claiming the canonical writer', () => {
  const base = mkdtempSync(join(tmpdir(), 'ovo-session-alias-'))
  directories.push(base)
  const canonical = join(base, 'canonical'), alias = join(base, 'alias')
  mkdirSync(canonical)
  symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  claimed.push(canonical, alias)
  const envelope = { version: 2, schema: 'ovogo.session.v2', updatedAt: new Date().toISOString(), sessionId: 'fixture-session', revision: 1, owner: { pid: 1, hostname: 'fixture', birthId: 'fixture' }, messages: [] }
  writeFileSync(join(canonical, 'history.json'), JSON.stringify(envelope))
  loadSession(alias)
  writeFileSync(join(canonical, 'history.json'), JSON.stringify({ ...envelope, revision: envelope.revision + 1 }))
  expect(() => claimSessionOwnership(canonical)).toThrow(/revision conflict/i)
})

it('preserves the legacy identity derived from the canonical path casing', () => {
  const base = mkdtempSync(join(tmpdir(), 'ovo-session-alias-'))
  directories.push(base)
  const canonical = join(base, 'OriginalSession')
  const alias = join(base, 'Alias')
  mkdirSync(canonical)
  symlinkSync(canonical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(canonical, 'history.json'), '[]')
  const expected = `legacy_${createHash('sha256').update(realpathSync(canonical)).digest('hex')}`
  expect(readSessionSnapshot(canonical).sessionId).toBe(expected)
  expect(readSessionSnapshot(alias).sessionId).toBe(expected)
})
