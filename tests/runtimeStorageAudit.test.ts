import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getMetadataPath, getSessionsDir, loadMetadata } from '../src/core/backgroundSession.js'
import { FileHistory } from '../src/core/fileHistory.js'
import { getSnapshotPath, listSnapshots, formatSnapshotList } from '../src/core/workspace.js'

const directories: string[] = []
function directory() {
  const path = mkdtempSync(join(tmpdir(), 'ovo-runtime-storage-audit-'))
  directories.push(path)
  return path
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('rejects nonstring background session timestamps without changing persisted evidence', () => {
  const home = directory()
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  mkdirSync(getSessionsDir(), { recursive: true })
  const path = getMetadataPath('schema-timestamp')
  const bytes = JSON.stringify({ id: 'schema-timestamp', task: 'resume', cwd: home, logPath: join(home, 'log'), startedAt: 2026, pid: null, status: 'completed' })
  writeFileSync(path, bytes)
  expect(() => loadMetadata('schema-timestamp')).toThrow('Invalid background metadata')
  expect(readFileSync(path, 'utf8')).toBe(bytes)
})

it('rebuilds same-millisecond file versions in their original write order', () => {
  const path = directory()
  const file = join(path, 'tracked.txt')
  const history = new FileHistory(path)
  vi.spyOn(Date, 'now').mockReturnValue(1234567890)
  for (let index = 0; index < 12; index++) {
    writeFileSync(file, 'version ' + index)
    expect(history.trackEdit(file).status).toBe('backed_up')
  }
  rmSync(join(path, 'file-history', 'index.json'))
  const recovered = new FileHistory(path)
  expect(recovered.getVersions(file).map(version => readFileSync(version.backupPath, 'utf8'))).toEqual(Array.from({ length: 12 }, (_, index) => 'version ' + index))
  expect(recovered.restoreVersion(file, 11)).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('version 11')
})

it('filters malformed workspace snapshots while preserving valid old records and file bytes', () => {
  const cwd = directory()
  const path = getSnapshotPath(cwd)
  mkdirSync(join(cwd, '.ovolv999'))
  const valid = { id: 'legacy', name: 'valid', createdAt: '', gitBranch: null, gitCommit: null, gitDirty: false, files: ['a.ts'], todos: [{ text: 'keep', done: false }], metadata: {} }
  const bytes = JSON.stringify({ snapshots: [null, {}, { ...valid, files: null }, { ...valid, todos: [null] }, { ...valid, createdAt: 2 }, valid] })
  writeFileSync(path, bytes)
  expect(listSnapshots(cwd)).toEqual([valid])
  expect(formatSnapshotList(listSnapshots(cwd))).toContain('valid')
  expect(readFileSync(path, 'utf8')).toBe(bytes)
  writeFileSync(path, 'null')
  expect(listSnapshots(cwd)).toEqual([])
})
