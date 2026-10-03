/**
 * Auto-Dream / Skill Learning
 *
 * Lets the agent self-improve by:
 *   - Recording successful patterns
 *   - Extracting reusable skills from completed tasks
 *   - Building a knowledge base of what worked
 *
 * Inspired by claude-code's auto-dream and skill-learning services.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { isRecord, isStringArray } from './persistedData.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface LearnedPattern {
  id: string
  trigger: string
  action: string
  context: string
  successCount: number
  failureCount: number
  lastUsed: string
  createdAt: string
  tags: string[]
}

export interface DreamEntry {
  id: string
  timestamp: string
  type: 'insight' | 'pattern' | 'mistake' | 'improvement'
  category: string
  description: string
  evidence?: string
  applied?: boolean
  confidence: number
}

export interface SkillExtraction {
  sourceTask: string
  extractedAt: string
  skillName: string
  description: string
  steps: string[]
  prerequisites: string[]
  tags: string[]
}

export interface KnowledgeEntry {
  id: string
  topic: string
  question: string
  answer: string
  confidence: number
  sources: string[]
  createdAt: string
  lastAccessed: string
  accessCount: number
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function getDreamDir(): string {
  return join(homedir(), '.ovolv999', 'dream')
}

export function getPatternsPath(): string {
  return join(getDreamDir(), 'patterns.json')
}

export function getDreamLogPath(): string {
  return join(getDreamDir(), 'dream-log.json')
}

export function getKnowledgePath(): string {
  return join(getDreamDir(), 'knowledge.json')
}

export function getSkillsExtractedDir(): string {
  return join(getDreamDir(), 'extracted-skills')
}

function ensureDirs(): void {
  const dirs = [getDreamDir(), getSkillsExtractedDir()]
  for (const d of dirs) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
  }
}

function loadJson<T>(path: string, validate: (value: unknown) => value is T): T[] {
  if (!existsSync(path)) return []
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(value) ? value.filter(validate) : []
  } catch {
    return []
  }
}

function hasStrings(value: Record<string, unknown>, fields: string[]): boolean {
  return fields.every(field => typeof value[field] === 'string')
}

function isCount(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) >= 0 }
function isConfidence(value: unknown): boolean { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 }

function isPattern(value: unknown): value is LearnedPattern {
  return isRecord(value) && hasStrings(value, ['id', 'trigger', 'action', 'context', 'lastUsed', 'createdAt'])
    && isCount(value.successCount) && isCount(value.failureCount) && isStringArray(value.tags)
}

function isDream(value: unknown): value is DreamEntry {
  return isRecord(value) && hasStrings(value, ['id', 'timestamp', 'category', 'description'])
    && typeof value.type === 'string' && ['insight', 'pattern', 'mistake', 'improvement'].includes(value.type) && isConfidence(value.confidence)
    && (value.evidence === undefined || typeof value.evidence === 'string') && (value.applied === undefined || typeof value.applied === 'boolean')
}

function isKnowledge(value: unknown): value is KnowledgeEntry {
  return isRecord(value) && hasStrings(value, ['id', 'topic', 'question', 'answer', 'createdAt', 'lastAccessed'])
    && isCount(value.accessCount) && isConfidence(value.confidence) && isStringArray(value.sources)
}

function isSkill(value: unknown): value is SkillExtraction {
  return isRecord(value) && hasStrings(value, ['sourceTask', 'extractedAt', 'skillName', 'description'])
    && isStringArray(value.steps) && isStringArray(value.prerequisites) && isStringArray(value.tags)
}

function saveJson(path: string, data: unknown): void {
  ensureDirs()
  writeFileSync(path, JSON.stringify(data, null, 2))
}

// ── Pattern Learning ────────────────────────────────────────────────────────

export function recordPattern(
  trigger: string,
  action: string,
  context: string,
  tags: string[] = [],
): LearnedPattern {
  ensureDirs()
  const patterns = loadJson(getPatternsPath(), isPattern)

  // Check if pattern exists
  const existing = patterns.find(p => p.trigger === trigger && p.action === action)
  if (existing) {
    existing.successCount++
    existing.lastUsed = new Date().toISOString()
    saveJson(getPatternsPath(), patterns)
    return existing
  }

  const now = new Date().toISOString()
  const pattern: LearnedPattern = {
    id: `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    trigger,
    action,
    context,
    successCount: 1,
    failureCount: 0,
    lastUsed: now,
    createdAt: now,
    tags,
  }

  patterns.push(pattern)
  saveJson(getPatternsPath(), patterns)
  return pattern
}

export function recordPatternFailure(trigger: string, action: string): void {
  const patterns = loadJson(getPatternsPath(), isPattern)
  const existing = patterns.find(p => p.trigger === trigger && p.action === action)
  if (existing) {
    existing.failureCount++
    existing.lastUsed = new Date().toISOString()
    saveJson(getPatternsPath(), patterns)
  }
}

export function getPatterns(): LearnedPattern[] {
  return loadJson(getPatternsPath(), isPattern)
}

export function findPatterns(trigger: string): LearnedPattern[] {
  return getPatterns()
    .filter(p => p.trigger.toLowerCase().includes(trigger.toLowerCase()))
    .sort((a, b) => b.successCount - a.successCount)
}

export function getTopPatterns(limit = 10): LearnedPattern[] {
  return getPatterns()
    .sort((a, b) => (b.successCount - b.failureCount) - (a.successCount - a.failureCount))
    .slice(0, limit)
}

// ── Dream Log ───────────────────────────────────────────────────────────────

export function dream(
  type: DreamEntry['type'],
  category: string,
  description: string,
  evidence?: string,
): DreamEntry {
  ensureDirs()
  const log = loadJson(getDreamLogPath(), isDream)

  const entry: DreamEntry = {
    id: `dream-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    type,
    category,
    description,
    evidence,
    applied: false,
    confidence: 0.5,
  }

  log.push(entry)
  saveJson(getDreamLogPath(), log)
  return entry
}

export function getDreamLog(limit?: number): DreamEntry[] {
  const log = loadJson(getDreamLogPath(), isDream)
  const sorted = log.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  return limit ? sorted.slice(0, limit) : sorted
}

export function markDreamApplied(id: string): void {
  const log = loadJson(getDreamLogPath(), isDream)
  const entry = log.find(d => d.id === id)
  if (entry) {
    entry.applied = true
    saveJson(getDreamLogPath(), log)
  }
}

// ── Knowledge Base ──────────────────────────────────────────────────────────

export function addKnowledge(
  topic: string,
  question: string,
  answer: string,
  sources: string[] = [],
): KnowledgeEntry {
  ensureDirs()
  const kb = loadJson(getKnowledgePath(), isKnowledge)

  const existing = kb.find(e => e.topic === topic && e.question === question)
  if (existing) {
    existing.answer = answer
    existing.sources = sources
    existing.lastAccessed = new Date().toISOString()
    saveJson(getKnowledgePath(), kb)
    return existing
  }

  const now = new Date().toISOString()
  const entry: KnowledgeEntry = {
    id: `kb-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    topic,
    question,
    answer,
    confidence: 0.7,
    sources,
    createdAt: now,
    lastAccessed: now,
    accessCount: 0,
  }

  kb.push(entry)
  saveJson(getKnowledgePath(), kb)
  return entry
}

export function searchKnowledge(query: string, limit = 5): KnowledgeEntry[] {
  const kb = loadJson(getKnowledgePath(), isKnowledge)
  const lower = query.toLowerCase()

  const results = kb
    .map(entry => {
      let score = 0
      if (entry.topic.toLowerCase().includes(lower)) score += 3
      if (entry.question.toLowerCase().includes(lower)) score += 2
      if (entry.answer.toLowerCase().includes(lower)) score += 1
      return { entry, score }
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ entry }) => {
      entry.accessCount++
      entry.lastAccessed = new Date().toISOString()
      return entry
    })
  if (results.length > 0) saveJson(getKnowledgePath(), kb)
  return results
}

export function getKnowledge(): KnowledgeEntry[] {
  return loadJson(getKnowledgePath(), isKnowledge)
}

// ── Skill Extraction ────────────────────────────────────────────────────────

export function extractSkill(extraction: Omit<SkillExtraction, 'extractedAt'>): SkillExtraction {
  const full: SkillExtraction = {
    ...extraction,
    extractedAt: new Date().toISOString(),
  }

  if (!isSkill(full) || !full.skillName.trim() || /[\\/:\0]/.test(full.skillName) || ['.', '..'].includes(full.skillName.trim())) throw new Error('Invalid extracted skill name or data')
  ensureDirs()

  const filename = `${full.skillName.replace(/\s+/g, '-').toLowerCase()}.json`
  writeFileSync(join(getSkillsExtractedDir(), filename), JSON.stringify(full, null, 2))
  return full
}

export function getExtractedSkills(): SkillExtraction[] {
  const dir = getSkillsExtractedDir()
  if (!existsSync(dir)) return []

  const skills: SkillExtraction[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (isSkill(value)) skills.push(value)
    } catch { /* skip */ }
  }
  return skills
}

// ── Formatting ──────────────────────────────────────────────────────────────

export function formatPattern(pattern: LearnedPattern): string {
  const success = pattern.successCount
  const failure = pattern.failureCount
  const total = success + failure
  const rate = total > 0 ? Math.round((success / total) * 100) : 0
  return [
    `Pattern: ${pattern.trigger} → ${pattern.action}`,
    `  Success: ${success}/${total} (${rate}%)`,
    `  Context: ${pattern.context}`,
    `  Last used: ${pattern.lastUsed}`,
  ].join('\n')
}

export function formatPatterns(patterns: LearnedPattern[]): string {
  if (patterns.length === 0) return 'No patterns learned yet.'
  return patterns.map(formatPattern).join('\n---\n')
}

export function formatDreamEntry(entry: DreamEntry): string {
  const icon = { insight: '💡', pattern: '🔄', mistake: '⚠', improvement: '↑' }[entry.type]
  const applied = entry.applied ? ' ✓' : ''
  return [
    `${icon} [${entry.type}] ${entry.category}${applied}`,
    `  ${entry.description}`,
    entry.evidence ? `  Evidence: ${entry.evidence}` : '',
  ].filter(Boolean).join('\n')
}

export function formatDreamLog(entries: DreamEntry[]): string {
  if (entries.length === 0) return 'No dream entries yet.'
  return entries.map(formatDreamEntry).join('\n---\n')
}

export function formatKnowledgeEntry(entry: KnowledgeEntry): string {
  return [
    `Q: ${entry.question}`,
    `A: ${entry.answer}`,
    `  Topic: ${entry.topic} | Confidence: ${(entry.confidence * 100).toFixed(0)}% | Accessed: ${entry.accessCount}`,
  ].join('\n')
}

export function formatSkillExtraction(skill: SkillExtraction): string {
  return [
    `Skill: ${skill.skillName}`,
    `  ${skill.description}`,
    `  Steps:`,
    ...skill.steps.map((s, i) => `    ${i + 1}. ${s}`),
    skill.tags.length > 0 ? `  Tags: ${skill.tags.join(', ')}` : '',
  ].filter(Boolean).join('\n')
}

export function formatDreamStats(): string {
  const patterns = getPatterns()
  const dreamLog = getDreamLog()
  const knowledge = getKnowledge()
  const skills = getExtractedSkills()

  const totalSuccess = patterns.reduce((s, p) => s + p.successCount, 0)
  const totalFailure = patterns.reduce((s, p) => s + p.failureCount, 0)
  const rate = totalSuccess + totalFailure > 0
    ? Math.round((totalSuccess / (totalSuccess + totalFailure)) * 100)
    : 0

  return [
    'Auto-Dream Stats:',
    `  Patterns learned: ${patterns.length} (${rate}% success rate)`,
    `  Dream entries: ${dreamLog.length}`,
    `  Knowledge entries: ${knowledge.length}`,
    `  Extracted skills: ${skills.length}`,
  ].join('\n')
}
