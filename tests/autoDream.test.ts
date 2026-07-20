import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  recordPattern,
  recordPatternFailure,
  getPatterns,
  findPatterns,
  getTopPatterns,
  dream,
  getDreamLog,
  markDreamApplied,
  addKnowledge,
  searchKnowledge,
  getKnowledge,
  extractSkill,
  getExtractedSkills,
  formatPattern,
  formatPatterns,
  formatDreamEntry,
  formatDreamLog,
  formatDreamStats,
  getDreamDir,
} from '../src/core/autoDream.js'
import { existsSync, rmSync, mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let testDir: string
let origHome: string | undefined

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ovolv999-dream-'))
  origHome = process.env.HOME
  process.env.HOME = testDir
})

afterAll(() => {
  if (origHome !== undefined) process.env.HOME = origHome
  rmSync(testDir, { recursive: true, force: true })
})

beforeEach(() => {
  // Clean dream dir
  if (existsSync(getDreamDir())) {
    rmSync(getDreamDir(), { recursive: true, force: true })
  }
  mkdirSync(getDreamDir(), { recursive: true })
  mkdirSync(join(getDreamDir(), 'extracted-skills'), { recursive: true })
})

describe('autoDream', () => {
  describe('pattern learning', () => {
    it('records a new pattern', () => {
      const p = recordPattern('fix TypeScript error', 'run tsc --noEmit', 'after editing .ts files')
      expect(p.trigger).toBe('fix TypeScript error')
      expect(p.successCount).toBe(1)
    })

    it('increments existing pattern', () => {
      recordPattern('fix TS', 'tsc', 'context')
      recordPattern('fix TS', 'tsc', 'context')
      const patterns = getPatterns()
      expect(patterns).toHaveLength(1)
      expect(patterns[0].successCount).toBe(2)
    })

    it('records failures', () => {
      recordPattern('fix TS', 'tsc', 'context')
      recordPatternFailure('fix TS', 'tsc')
      const patterns = getPatterns()
      expect(patterns[0].failureCount).toBe(1)
    })

    it('finds patterns by trigger', () => {
      recordPattern('fix TypeScript', 'tsc', 'c1')
      recordPattern('fix Python', 'ruff', 'c2')
      const found = findPatterns('typescript')
      expect(found).toHaveLength(1)
      expect(found[0].action).toBe('tsc')
    })

    it('sorts by success count', () => {
      recordPattern('a', 'act1', 'c')
      recordPattern('b', 'act2', 'c')
      recordPattern('b', 'act2', 'c')
      const top = getTopPatterns(2)
      expect(top[0].successCount).toBeGreaterThanOrEqual(top[1].successCount)
    })
  })

  describe('dream log', () => {
    it('creates a dream entry', () => {
      const entry = dream('insight', 'testing', 'Always run tests after changes')
      expect(entry.type).toBe('insight')
      expect(entry.description).toContain('Always run tests')
      expect(entry.applied).toBe(false)
    })

    it('retrieves dream log', () => {
      dream('insight', 'a', 'first')
      dream('mistake', 'b', 'second')
      const log = getDreamLog()
      expect(log).toHaveLength(2)
    })

    it('marks dream as applied', () => {
      const entry = dream('pattern', 'x', 'desc')
      markDreamApplied(entry.id)
      const log = getDreamLog()
      expect(log.find(d => d.id === entry.id)!.applied).toBe(true)
    })
  })

  describe('knowledge base', () => {
    it('adds knowledge', () => {
      const entry = addKnowledge('testing', 'how to run tests?', 'use vitest run')
      expect(entry.topic).toBe('testing')
      expect(entry.answer).toBe('use vitest run')
    })

    it('updates existing knowledge', () => {
      addKnowledge('git', 'how to commit?', 'git commit')
      addKnowledge('git', 'how to commit?', 'git commit -m "msg"')
      const kb = getKnowledge()
      expect(kb).toHaveLength(1)
      expect(kb[0].answer).toBe('git commit -m "msg"')
    })

    it('searches knowledge', () => {
      addKnowledge('testing', 'how to test?', 'use vitest')
      addKnowledge('git', 'how to push?', 'git push')
      const results = searchKnowledge('test')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0].topic).toBe('testing')
    })

    it('returns empty for no matches', () => {
      addKnowledge('a', 'q', 'a')
      expect(searchKnowledge('xyz')).toHaveLength(0)
    })
  })

  describe('skill extraction', () => {
    it('extracts a skill', () => {
      const skill = extractSkill({
        sourceTask: 'fix bug in auth',
        skillName: 'Auth debugging',
        description: 'How to debug auth issues',
        steps: ['check logs', 'verify token', 'test endpoint'],
        prerequisites: ['access to logs'],
        tags: ['auth', 'debugging'],
      })
      expect(skill.skillName).toBe('Auth debugging')
      expect(skill.steps).toHaveLength(3)
    })

    it('retrieves extracted skills', () => {
      extractSkill({
        sourceTask: 'task',
        skillName: 'Test Skill',
        description: 'desc',
        steps: ['step1'],
        prerequisites: [],
        tags: [],
      })
      const skills = getExtractedSkills()
      expect(skills).toHaveLength(1)
      expect(skills[0].skillName).toBe('Test Skill')
    })
  })

  describe('formatting', () => {
    it('formats a pattern', () => {
      const p = recordPattern('trigger', 'action', 'context')
      const out = formatPattern(p)
      expect(out).toContain('trigger')
      expect(out).toContain('action')
      expect(out).toContain('100%') // 1 success, 0 failures
    })

    it('formats empty patterns', () => {
      expect(formatPatterns([])).toContain('No patterns')
    })

    it('formats dream entry', () => {
      const entry = dream('insight', 'cat', 'description here')
      const out = formatDreamEntry(entry)
      expect(out).toContain('insight')
      expect(out).toContain('cat')
    })

    it('formats dream log', () => {
      dream('insight', 'x', 'first')
      dream('mistake', 'y', 'second')
      const out = formatDreamLog(getDreamLog())
      expect(out).toContain('first')
      expect(out).toContain('second')
    })

    it('formats dream stats', () => {
      recordPattern('t', 'a', 'c')
      dream('insight', 'x', 'desc')
      addKnowledge('topic', 'q', 'a')
      const out = formatDreamStats()
      expect(out).toContain('Patterns learned: 1')
      expect(out).toContain('Dream entries: 1')
      expect(out).toContain('Knowledge entries: 1')
    })
  })
})
