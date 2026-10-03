import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { syncPull, syncPush } from '../../src/core/settingsSync.js'

let fixture: string
let remote: string
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'settings sync regression '))
  vi.stubEnv('HOME', fixture)
  vi.stubEnv('USERPROFILE', fixture)
  vi.stubEnv('GIT_AUTHOR_NAME', 'Regression Test')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid')
  vi.stubEnv('GIT_COMMITTER_NAME', 'Regression Test')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid')
  remote = join(fixture, 'remote repo.git')
  git(['init', '--bare', '--initial-branch=main', remote])
  const seed = join(fixture, 'seed')
  git(['init', '--initial-branch=main', seed])
  writeFileSync(join(seed, 'shared.txt'), 'preserve remote history')
  git(['add', '.'], seed)
  git(['commit', '-m', 'initial fixture'], seed)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', 'origin', 'main'], seed)
  mkdirSync(join(fixture, '.ovolv999'))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }) })

describe('settings git synchronization', () => {
  it('pushes twice to the configured branch and preserves the existing temporary directory', () => {
    const oldTemporary = join(fixture, '.ovolv999', 'sync-tmp')
    mkdirSync(oldTemporary)
    writeFileSync(join(oldTemporary, 'owned-by-other-operation'), 'keep')
    writeFileSync(join(fixture, '.ovolv999', 'settings.json'), JSON.stringify({ model: 'first' }))
    expect(syncPush({ transport: 'git', repo: remote })).toMatchObject({ success: true })
    writeFileSync(join(fixture, '.ovolv999', 'settings.json'), JSON.stringify({ model: 'second' }))
    expect(syncPush({ transport: 'git', repo: remote })).toMatchObject({ success: true })
    const bundle = JSON.parse(git(['--git-dir', remote, 'show', 'ovolv999-sync:ovolv999-bundle.json']))
    expect(bundle.settings).toEqual({ model: 'second' })
    expect(git(['--git-dir', remote, 'show', 'ovolv999-sync:shared.txt'])).toBe('preserve remote history')
    expect(readFileSync(join(oldTemporary, 'owned-by-other-operation'), 'utf8')).toBe('keep')
    expect(syncPull({ transport: 'git', repo: remote, dryRun: true })).toMatchObject({ success: true, bundle: { settings: { model: 'second' } } })
  })

  it('rejects a parsed value that is not a settings bundle even in dry-run or force mode', () => {
    const filePath = join(fixture, 'invalid.json')
    writeFileSync(filePath, 'null')
    expect(syncPull({ transport: 'file', filePath, dryRun: true, force: true })).toMatchObject({ success: false })
  })
})
