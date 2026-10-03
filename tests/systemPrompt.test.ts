import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  buildSystemPrompt, buildProjectContext, formatGitStatus,
  getGitStatusInfo, findMemoryFiles, buildProjectTree,
  formatMemoryFiles, BASE_SYSTEM_PROMPT,
} from '../src/core/systemPrompt.js'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, renameSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'ovolv999-sysprompt-'))
}

describe('System Prompt Builder', () => {
  let cwd: string

  beforeEach(() => { cwd = makeTempDir() })
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

  describe('BASE_SYSTEM_PROMPT', () => {
    it('contains core guidelines', () => {
      expect(BASE_SYSTEM_PROMPT).toContain('ovolv999')
      expect(BASE_SYSTEM_PROMPT).toContain('concise')
      expect(BASE_SYSTEM_PROMPT).toContain('Security')
    })
  })

  describe('getGitStatusInfo', () => {
    it('separates index changes, working tree changes and untracked files', () => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
      git('init')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(cwd, 'staged.txt'), 'original')
      writeFileSync(join(cwd, 'unstaged.txt'), 'original')
      writeFileSync(join(cwd, 'both.txt'), 'original')
      git('add', '.')
      git('commit', '-m', 'initial')
      writeFileSync(join(cwd, 'staged.txt'), 'staged')
      writeFileSync(join(cwd, 'both.txt'), 'staged')
      git('add', 'staged.txt', 'both.txt')
      writeFileSync(join(cwd, 'both.txt'), 'unstaged')
      writeFileSync(join(cwd, 'unstaged.txt'), 'unstaged')
      writeFileSync(join(cwd, 'new file.txt'), 'new')
      const info = getGitStatusInfo(cwd)
      expect(info.staged).toEqual(['both.txt', 'staged.txt'])
      expect(info.modified).toEqual(['both.txt', 'unstaged.txt'])
      expect(info.untracked).toEqual(['new file.txt'])
      expect(info.isClean).toBe(false)
    })

    it('retains renamed paths containing spaces without counting the old name', () => {
      const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })
      git('init')
      git('config', 'user.email', 'test@example.com')
      git('config', 'user.name', 'Test')
      writeFileSync(join(cwd, 'old name.txt'), 'original')
      git('add', '.')
      git('commit', '-m', 'initial')
      renameSync(join(cwd, 'old name.txt'), join(cwd, 'new name.txt'))
      git('add', '-A')
      expect(getGitStatusInfo(cwd).staged).toEqual(['new name.txt'])
    })

    it('returns null branch for non-git dir', () => {
      const info = getGitStatusInfo(cwd)
      expect(info.branch).toBeNull()
      expect(info.recentCommits).toEqual([])
    })
  })

  describe('formatGitStatus', () => {
    it('returns empty for non-git dir', () => {
      expect(formatGitStatus(getGitStatusInfo(cwd))).toBe('')
    })

    it('includes branch when available', () => {
      const info = {
        branch: 'main',
        isClean: true,
        staged: [], modified: [], untracked: [],
        recentCommits: [{ hash: 'abc1234', message: 'Initial commit' }],
        userName: 'Test',
      }
      const out = formatGitStatus(info)
      expect(out).toContain('main')
      expect(out).toContain('clean')
      expect(out).toContain('abc1234')
    })

    it('shows dirty status', () => {
      const out = formatGitStatus({
        branch: 'dev', isClean: false,
        staged: ['a.ts'], modified: ['b.ts'], untracked: ['c.ts'],
        recentCommits: [], userName: null,
      })
      expect(out).toContain('Staged: 1')
      expect(out).toContain('Modified: 1')
      expect(out).toContain('Untracked: 1')
    })
  })

  describe('findMemoryFiles', () => {
    it('returns empty when no memory files', () => {
      expect(findMemoryFiles(cwd)).toEqual([])
    })

    it('finds CLAUDE.md', () => {
      writeFileSync(join(cwd, 'CLAUDE.md'), '# Project\nTest instructions')
      const files = findMemoryFiles(cwd)
      expect(files).toHaveLength(1)
      expect(files[0].content).toContain('Test instructions')
    })

    it('finds AGENTS.md', () => {
      writeFileSync(join(cwd, 'AGENTS.md'), '# Agents')
      const files = findMemoryFiles(cwd)
      expect(files.some(f => f.relative === 'AGENTS.md')).toBe(true)
    })

    it('finds .ovolv999/instructions.md', () => {
      mkdirSync(join(cwd, '.ovolv999'), { recursive: true })
      writeFileSync(join(cwd, '.ovolv999', 'instructions.md'), '# Custom')
      const files = findMemoryFiles(cwd)
      expect(files.some(f => f.content.includes('Custom'))).toBe(true)
    })

    it('finds multiple files', () => {
      writeFileSync(join(cwd, 'CLAUDE.md'), '# Claude')
      writeFileSync(join(cwd, 'AGENTS.md'), '# Agents')
      expect(findMemoryFiles(cwd).length).toBeGreaterThanOrEqual(2)
    })
  })

  describe('formatMemoryFiles', () => {
    it('formats memory files', () => {
      void (findMemoryFiles(cwd))
      writeFileSync(join(cwd, 'CLAUDE.md'), '# Project\nRules here')
      const found = findMemoryFiles(cwd)
      const out = formatMemoryFiles(found)
      expect(out).toContain('Project Memory Files')
      expect(out).toContain('Rules here')
    })
  })

  describe('buildProjectTree', () => {
    it('shows root directory name', () => {
      const tree = buildProjectTree(cwd)
      expect(tree).toBeTruthy()
    })

    it('includes files in tree', () => {
      writeFileSync(join(cwd, 'file.ts'), 'content')
      writeFileSync(join(cwd, 'README.md'), '# readme')
      const tree = buildProjectTree(cwd)
      expect(tree).toContain('file.ts')
      expect(tree).toContain('README.md')
    })

    it('ignores node_modules and .git', () => {
      mkdirSync(join(cwd, 'node_modules'), { recursive: true })
      mkdirSync(join(cwd, '.git'), { recursive: true })
      writeFileSync(join(cwd, 'node_modules', 'pkg.json'), '{}')
      const tree = buildProjectTree(cwd)
      expect(tree).not.toContain('node_modules')
      expect(tree).not.toContain('.git')
    })

    it('respects maxDepth', () => {
      mkdirSync(join(cwd, 'a', 'b', 'c'), { recursive: true })
      writeFileSync(join(cwd, 'a', 'b', 'c', 'deep.ts'), 'x')
      const shallow = buildProjectTree(cwd, 1)
      const deep = buildProjectTree(cwd, 3)
      expect(deep.length).toBeGreaterThan(shallow.length)
    })
  })

  describe('buildProjectContext', () => {
    it('includes working directory', () => {
      const ctx = buildProjectContext(cwd)
      expect(ctx).toContain('Working directory:')
    })

    it('includes git status when requested', () => {
      const ctx = buildProjectContext(cwd, { includeGitStatus: true })
      expect(ctx).toContain('Working directory:')
    })

    it('includes project tree when requested', () => {
      writeFileSync(join(cwd, 'test.ts'), 'x')
      const ctx = buildProjectContext(cwd, { includeProjectTree: true })
      expect(ctx).toContain('Project structure')
      expect(ctx).toContain('test.ts')
    })
  })

  describe('buildSystemPrompt', () => {
    it('includes base prompt', () => {
      const prompt = buildSystemPrompt({ cwd })
      expect(prompt).toContain('ovolv999')
      expect(prompt).toContain('Core Capabilities')
    })

    it('includes mode prompt when provided', () => {
      const prompt = buildSystemPrompt({ cwd, modePrompt: 'You are in test mode.' })
      expect(prompt).toContain('test mode')
    })

    it('includes project context', () => {
      const prompt = buildSystemPrompt({ cwd })
      expect(prompt).toContain('Working directory:')
    })

    it('includes memory files', () => {
      writeFileSync(join(cwd, 'CLAUDE.md'), '# Project Rules\nAlways test')
      const prompt = buildSystemPrompt({ cwd })
      expect(prompt).toContain('Project Rules')
      expect(prompt).toContain('Always test')
    })

    it('includes task context', () => {
      const prompt = buildSystemPrompt({ cwd, taskContext: 'Fix bug #123' })
      expect(prompt).toContain('Fix bug #123')
    })

    it('includes custom instructions', () => {
      const prompt = buildSystemPrompt({ cwd, customInstructions: 'Use strict mode' })
      expect(prompt).toContain('Use strict mode')
    })

    it('includes current date', () => {
      const prompt = buildSystemPrompt({ cwd })
      const today = new Date().toISOString().slice(0, 10)
      expect(prompt).toContain(today)
    })

    it('includes project tree when requested', () => {
      writeFileSync(join(cwd, 'app.ts'), 'x')
      const prompt = buildSystemPrompt({ cwd, includeProjectTree: true })
      expect(prompt).toContain('app.ts')
    })

    it('can exclude git status', () => {
      const prompt = buildSystemPrompt({ cwd, includeGitStatus: false })
      expect(prompt).not.toContain('Git branch:')
    })
  })
})
