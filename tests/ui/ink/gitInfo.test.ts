import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getGitBranch, refreshGitBranch } from '../../../src/ui/ink/gitInfo.js'

describe('workspace Git branch cache', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-git-info-'))
    refreshGitBranch()
  })

  afterEach(() => {
    refreshGitBranch()
    rmSync(directory, { recursive: true, force: true })
  })

  function repository(name: string, branch: string): string {
    const cwd = join(directory, name)
    mkdirSync(cwd)
    execFileSync('git', ['init', '-b', branch], { cwd, stdio: 'pipe' })
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Branch Fixture',
        '-c',
        'user.email=branch@example.test',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      { cwd, stdio: 'pipe' },
    )
    return cwd
  }

  it('reports each workspace branch instead of reusing the first result', () => {
    const first = repository('first', 'first-branch')
    const second = repository('second', 'second-branch')
    expect(getGitBranch(first)).toBe('first-branch')
    expect(getGitBranch(second)).toBe('second-branch')
    expect(getGitBranch(first)).toBe('first-branch')
  })

  it('does not share a failed lookup with a different workspace', () => {
    expect(getGitBranch(directory)).toBeNull()
    expect(getGitBranch(repository('valid', 'valid-branch'))).toBe('valid-branch')
  })

  it('refreshes every workspace after cached branches have changed', () => {
    const first = repository('first', 'first-branch')
    const second = repository('second', 'second-branch')
    getGitBranch(first)
    getGitBranch(second)
    execFileSync('git', ['branch', '-m', 'renamed-first'], { cwd: first, stdio: 'pipe' })
    execFileSync('git', ['branch', '-m', 'renamed-second'], { cwd: second, stdio: 'pipe' })
    refreshGitBranch()
    expect(getGitBranch(first)).toBe('renamed-first')
    expect(getGitBranch(second)).toBe('renamed-second')
  })
})
