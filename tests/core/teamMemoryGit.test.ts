import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getTeamMemoryDir, initTeamMemory, loadTeamConfig, readTeamMemoryFile, syncTeamMemory } from '../../src/core/teamMemory.js'

let fixture: string
let remote: string
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'team memory regression '))
  vi.stubEnv('HOME', fixture)
  vi.stubEnv('USERPROFILE', fixture)
  vi.stubEnv('GIT_AUTHOR_NAME', 'Regression Test')
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.invalid')
  vi.stubEnv('GIT_COMMITTER_NAME', 'Regression Test')
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.invalid')
  remote = join(fixture, 'remote repo.git')
  git(['init', '--bare', '--initial-branch=main', remote])
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(fixture, { recursive: true, force: true }) })

describe('team memory git lifecycle', () => {
  it('commits and pushes memory text with a multiword commit message through native arguments', () => {
    const file = join(fixture, 'AGENTS.md')
    writeFileSync(file, 'Shared coding conventions')
    expect(initTeamMemory(remote).success).toBe(true)
    const result = syncTeamMemory({ remoteUrl: remote, files: [file] })
    expect(result).toMatchObject({ success: true, pushed: ['AGENTS.md'] })
    expect(git(['--git-dir', remote, 'show', 'main:AGENTS.md'])).toBe('Shared coding conventions')
    expect(git(['--git-dir', remote, 'log', '-1', '--format=%s'])).toMatch(/^sync memory files \(.+\)\s*$/)
  })

  it('does not claim pushed files when the remote update fails', () => {
    const file = join(fixture, 'CLAUDE.md')
    writeFileSync(file, 'Project instructions')
    initTeamMemory(remote)
    git(['remote', 'set-url', 'origin', join(fixture, 'missing remote.git')], getTeamMemoryDir())
    expect(syncTeamMemory({ remoteUrl: remote, files: [file] })).toMatchObject({ success: false, pushed: [] })
  })

  it.each(['add', 'commit'])('stops the sync when %s fails before publishing any files', stage => {
    const file = join(fixture, 'AGENTS.md')
    writeFileSync(file, 'Project instructions')
    expect(initTeamMemory(remote).success).toBe(true)
    if (stage === 'add') writeFileSync(join(getTeamMemoryDir(), '.git', 'index.lock'), 'fixture lock')
    else {
      git(['config', 'commit.gpgsign', 'true'], getTeamMemoryDir())
      git(['config', 'gpg.program', 'nonexistent-fixture-signing-program'], getTeamMemoryDir())
    }
    const result = syncTeamMemory({ remoteUrl: remote, files: [file] })
    expect(result).toMatchObject({ success: false, pushed: [] })
    expect(result.errors.join('\n').toLowerCase()).toContain(`${stage} failed`)
    expect(git(['--git-dir', remote, 'for-each-ref', '--format=%(refname)'])).toBe('')
  })

  it('stops after a failed rebase and preserves the remote contents', () => {
    const file = join(fixture, 'AGENTS.md')
    const config = { remoteUrl: remote, files: [file] }
    writeFileSync(file, 'original instructions')
    expect(syncTeamMemory(config).success).toBe(true)
    const other = join(fixture, 'other clone')
    git(['clone', remote, other])
    writeFileSync(join(other, 'AGENTS.md'), 'remote instructions')
    git(['add', '--', 'AGENTS.md'], other)
    git(['commit', '-m', 'concurrent update'], other)
    git(['push', 'origin', 'main'], other)
    writeFileSync(file, 'local conflicting instructions')
    const result = syncTeamMemory(config)
    expect(result).toMatchObject({ success: false, pushed: [] })
    expect(result.errors.join('\n')).toContain('Pull failed')
    expect(git(['--git-dir', remote, 'show', 'main:AGENTS.md'])).toBe('remote instructions')
  })

  it('refuses memory reads outside the memory directory and invalid config shapes', () => {
    mkdirSync(getTeamMemoryDir(), { recursive: true })
    writeFileSync(join(fixture, '.ovolv999', 'secret.txt'), 'private')
    expect(readTeamMemoryFile('../secret.txt')).toBeNull()
    writeFileSync(join(fixture, '.ovolv999', 'team-memory.json'), JSON.stringify({ remoteUrl: remote, files: null }))
    expect(loadTeamConfig()).toBeNull()
  })
})
