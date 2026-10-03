import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getGitStatusInfo } from '../../src/core/systemPrompt.js'
import { enrichContext, getGitState, scanForTODOs } from '../../src/core/suggestions.js'
import { isTestFile } from '../../src/core/promptSuggestions.js'
import { formatMessagesForCritic } from '../../src/prompts/critic.js'

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'ovogo-ui-extra-')) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(cwd, { recursive: true, force: true }) })
function git(...args: string[]): string { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
function repository(): void {
  git('init'); git('config', 'user.email', 'fixture@example.com'); git('config', 'user.name', 'Fixture')
  writeFileSync(join(cwd, 'tracked.ts'), 'const value = 1\n')
  git('add', '.'); git('commit', '-m', 'initial')
}

describe('prompt and suggestion boundaries', () => {
  it('reports a new repository branch and untracked files before its first commit', () => {
    git('init', '--initial-branch=fixture')
    writeFileSync(join(cwd, 'new file.ts'), 'uncommitted')
    expect(getGitStatusInfo(cwd)).toMatchObject({ branch: 'fixture', isClean: false, untracked: ['new file.ts'], recentCommits: [] })
  })
  it('formats valid JSON null arguments without crashing the critic', () => {
    expect(formatMessagesForCritic([{ role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'Read', arguments: 'null' } }] }])).toContain('[TOOL_CALL] Read({})')
  })

  it('does not report git in a directory outside a repository', () => {
    expect(getGitState(cwd).hasGit).toBe(false)
  })

  it('keeps the first porcelain status column intact and recognizes untracked changes', () => {
    repository()
    writeFileSync(join(cwd, 'tracked.ts'), 'const value = 2\n')
    expect(getGitState(cwd)).toMatchObject({ modifiedCount: 1, stagedCount: 0, modifiedFiles: ['tracked.ts'] })
    git('add', 'tracked.ts')
    expect(enrichContext({}, cwd).modifiedFiles).toEqual(['tracked.ts'])
    git('reset', '--', 'tracked.ts')
    writeFileSync(join(cwd, 'new file.ts'), 'new file')
    git('checkout', '--', 'tracked.ts')
    expect(enrichContext({}, cwd).hasUncommittedChanges).toBe(true)
    expect(enrichContext({}, cwd).modifiedFiles).toEqual(['new file.ts'])
  })

  it('retains git changes and commits when user.name is not configured', () => {
    repository()
    git('config', '--unset', 'user.name')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_CONFIG_GLOBAL', join(cwd, 'missing-global-config'))
    writeFileSync(join(cwd, 'tracked.ts'), 'dirty')
    expect(getGitStatusInfo(cwd)).toMatchObject({ userName: null, modified: ['tracked.ts'], recentCommits: [{ message: 'initial' }] })
  })

  it('scans tracked TODO files with platform-independent git arguments', () => {
    repository()
    writeFileSync(join(cwd, 'tracked.ts'), 'TODO FIXME')
    expect(scanForTODOs(cwd)).toEqual({ count: 2, files: ['tracked.ts'] })
  })

  it('recognizes Windows test directories without matching contest folders', () => {
    expect(isTestFile('tests\\integration\\feature.ts')).toBe(true)
    expect(isTestFile('contest/feature.ts')).toBe(false)
  })
})
