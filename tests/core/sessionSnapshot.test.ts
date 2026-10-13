import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readSessionSnapshot, releaseSessionOwnership, saveSession, validateSessionMessages } from '../../src/core/sessionManager.js'

it('exposes stable session identity, revision and detached canonical history', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ovo-session-snapshot-'))
  try {
    const before = readSessionSnapshot(dir)
    expect(before).toMatchObject({ revision: 0, messages: [], owner: null })
    saveSession(dir, [{ role: 'user', content: 'original' }])
    const after = readSessionSnapshot(dir)
    expect(after).toMatchObject({ sessionId: before.sessionId, revision: 1 })
    after.messages[0].content = 'changed'
    expect(readSessionSnapshot(dir).messages[0].content).toBe('original')
  } finally { releaseSessionOwnership(dir); rmSync(dir, { recursive: true, force: true }) }
})

it('validates derived history without publishing or mutating it', () => {
  const valid = [{ role: 'user', content: 'original' }]
  expect(() => validateSessionMessages(valid)).not.toThrow()
  expect(valid).toEqual([{ role: 'user', content: 'original' }])
  for (const invalid of [null, {}, [null], [{ role: 'tool', content: 'orphan' }], [{ role: 'user', content: 4 }]]) {
    expect(() => validateSessionMessages(invalid)).toThrow()
  }
})
