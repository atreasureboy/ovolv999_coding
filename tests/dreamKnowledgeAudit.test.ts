import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordPattern, getPatterns, findPatterns, dream, getDreamLog, addKnowledge, searchKnowledge, getKnowledge, extractSkill, getExtractedSkills, formatDreamStats, getDreamDir } from '../src/core/autoDream.js'
import { addEntry, getKnowledgePath, loadKnowledge, searchKnowledge as searchProjectKnowledge } from '../src/core/knowledgeBase.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dream-knowledge-audit-'))
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

it('ignores malformed pattern rows while retaining usable learned patterns', () => {
  const entry = recordPattern('Compile project', 'run checker', 'after edits')
  const path = join(getDreamDir(), 'patterns.json')
  writeFileSync(path, JSON.stringify([null, { ...entry, trigger: 1 }, entry]))
  expect(findPatterns('compile')).toEqual([entry])
  writeFileSync(path, 'null')
  expect(getPatterns()).toEqual([])
  expect(readFileSync(path, 'utf8')).toBe('null')
})

it('ignores malformed dream and skill rows when reporting learned knowledge', () => {
  const entry = dream('insight', 'testing', 'Always check behavior')
  writeFileSync(join(getDreamDir(), 'dream-log.json'), JSON.stringify([null, { ...entry, timestamp: 42 }, entry]))
  expect(getDreamLog()).toEqual([entry])
  writeFileSync(join(getDreamDir(), 'extracted-skills', 'broken.json'), 'null')
  expect(getExtractedSkills()).toEqual([])
  expect(formatDreamStats()).toContain('Dream entries: 1')
})

it('ignores malformed global knowledge rows before searching', () => {
  const entry = addKnowledge('testing', 'how to test', 'check behavior')
  writeFileSync(join(getDreamDir(), 'knowledge.json'), JSON.stringify([null, { ...entry, answer: 3 }, entry]))
  expect(searchKnowledge('testing')).toHaveLength(1)
})

it('persists global knowledge usage after a successful search', () => {
  addKnowledge('testing', 'how to test', 'check behavior')
  expect(searchKnowledge('testing')[0].accessCount).toBe(1)
  expect(getKnowledge()[0].accessCount).toBe(1)
  searchKnowledge('testing')
  expect(getKnowledge()[0].accessCount).toBe(2)
})

it.each(['../escaped', '..\\escaped'])('rejects extracted skill path escape %s before writing outside its directory', skillName => {
  mkdirSync(getDreamDir(), { recursive: true })
  expect(() => extractSkill({ sourceTask: 'task', skillName, description: 'description', steps: [], prerequisites: [], tags: [] })).toThrow(/name|path/i)
  expect(existsSync(join(getDreamDir(), 'escaped.json'))).toBe(false)
})

it('loads only valid project knowledge rows and preserves malformed bytes during inspection', () => {
  const valid = addEntry(root, 'file', 'source.ts', 'project source')
  const path = getKnowledgePath(root)
  const text = JSON.stringify({ entries: [null, { ...valid, tags: [42] }, { ...valid, key: 1 }, valid] })
  writeFileSync(path, text)
  expect(searchProjectKnowledge(root, 'source')).toEqual([valid])
  expect(readFileSync(path, 'utf8')).toBe(text)
  writeFileSync(path, 'null')
  expect(loadKnowledge(root)).toEqual({ entries: [] })
})
