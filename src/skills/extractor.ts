/**
 * Skill Extractor — learn reusable skills from conversation patterns.
 *
 * Analyzes recent messages and tool calls to generate a markdown skill
 * file that can be reused via /skill-name.
 *
 * Two modes:
 *   1. Manual: /skill-save <name> — extract a skill from the current session
 *   2. Automatic: detect repeated patterns and suggest skills (future)
 *
 * Generated skill format (compatible with existing loader.ts):
 *   ---
 *   name: fix-lint-errors
 *   description: Fix linting errors in a file
 *   ---
 *   # Fix Lint Errors
 *
 *   ## Task
 *   Fix linting errors in $ARGS
 *
 *   ## Approach
 *   1. Read the file
 *   2. Run the linter
 *   3. Fix each error
 *   4. Re-run to verify
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import type { OpenAIMessage } from '../core/types.js'
import { str } from '../core/strings.js'

export type { OpenAIMessage }

// ── Types ───────────────────────────────────────────────────────────────────

export interface SkillExtraction {
  name: string
  description: string
  prompt: string
  /** Detected task category */
  category: TaskCategory
  /** Tool calls in execution order */
  toolSequence: ToolCallEntry[]
  /** Number of messages analyzed */
  messageCount: number
  /** Number of user messages (turns) */
  turnCount: number
}

export type TaskCategory =
  | 'bug-fix'
  | 'feature'
  | 'refactor'
  | 'test'
  | 'docs'
  | 'review'
  | 'explore'
  | 'config'
  | 'unknown'

export interface ToolCallEntry {
  name: string
  /** First argument or brief description */
  summary: string
}

export interface ExtractionOptions {
  /** Name for the skill */
  name: string
  /** Optional description override */
  description?: string
  /** Max messages to analyze (default: 50) */
  maxMessages?: number
}

const CATEGORIES = ['bug-fix', 'feature', 'refactor', 'test', 'docs', 'review', 'explore', 'config'] as const

const CATEGORY_KEYWORDS: Record<typeof CATEGORIES[number], readonly string[]> = {
  'bug-fix': ['bug', 'error', 'fix', 'broken', 'crash', 'fail', 'issue', 'wrong', 'incorrect'],
  feature: ['add', 'implement', 'create', 'build', 'new', 'feature', 'support'],
  refactor: ['refactor', 'cleanup', 'clean up', 'simplify', 'restructure', 'optimize', 'rename'],
  test: ['test', 'spec', 'coverage', 'vitest', 'jest', 'pytest'],
  docs: ['document', 'docs', 'readme', 'comment', 'jSDoc', 'explain'],
  review: ['review', 'audit', 'check', 'inspect', 'analyze'],
  explore: ['explore', 'find', 'search', 'where', 'how does', 'understand'],
  config: ['config', 'configure', 'setup', 'install', 'environment', 'tsconfig', 'package.json'],
}

const CATEGORY_TIPS: Partial<Record<TaskCategory, readonly string[]>> = {
  'bug-fix': [
    'Reproduce the bug first before attempting a fix',
    'Check related tests after making changes',
    'Look for similar patterns elsewhere in the codebase',
  ],
  feature: [
    'Check existing patterns and conventions first',
    'Add tests for new functionality',
    'Update documentation if the feature is user-facing',
  ],
  refactor: [
    'Ensure existing tests pass after each change',
    'Make incremental changes — one refactor at a time',
    'Preserve public API unless explicitly changing it',
  ],
  test: [
    'Cover both success and error cases',
    'Use descriptive test names that explain the scenario',
    'Aim for deterministic tests — avoid time/random dependencies',
  ],
  docs: [
    'Write for the reader who knows least',
    'Include code examples',
    'Keep paragraphs short',
  ],
}

interface ToolExtraction {
  action: string
  summarize: (args: Record<string, unknown>) => string
}

function summarizeFilePath(args: Record<string, unknown>): string {
  return str(args.file_path ?? args.path ?? '')
}

function summarizePattern(args: Record<string, unknown>): string {
  return str(args.pattern ?? '')
}

const TOOL_EXTRACTIONS: ReadonlyMap<string, ToolExtraction> = new Map<string, ToolExtraction>([
  ['Read', { action: 'Read', summarize: summarizeFilePath }],
  ['Write', { action: 'Write', summarize: summarizeFilePath }],
  ['Edit', { action: 'Edit', summarize: summarizeFilePath }],
  ['Bash', { action: 'Run', summarize: args => str(args.command ?? '').slice(0, 60) }],
  ['Grep', { action: 'Search for', summarize: summarizePattern }],
  ['Glob', { action: 'Find files matching', summarize: summarizePattern }],
  ['Agent', { action: 'Dispatch agent to', summarize: args => str(args.description ?? args.prompt ?? '').slice(0, 60) }],
  ['TodoWrite', { action: 'Update task list with', summarize: args => `${(args.todos as unknown[] ?? []).length} items` }],
  ['WebFetch', { action: 'Fetch', summarize: args => str(args.url ?? '').slice(0, 60) }],
  ['WebSearch', { action: 'Search the web for', summarize: args => str(args.query ?? '').slice(0, 60) }],
])

// ── Category Detection ──────────────────────────────────────────────────────

/**
 * Detect the task category from user messages.
 */
export function detectCategory(messages: OpenAIMessage[]): TaskCategory {
  const userText = messages
    .filter(m => m.role === 'user')
    .map(m => typeof m.content === 'string' ? m.content : '')
    .join(' ')
    .toLowerCase()

  if (!userText) return 'unknown'

  let best: TaskCategory = 'unknown'
  let bestScore = 0
  for (const category of CATEGORIES) {
    const score = CATEGORY_KEYWORDS[category].reduce((count, word) => count + Number(userText.includes(word)), 0)
    if (score > bestScore) {
      bestScore = score
      best = category
    }
  }

  return best
}

// ── Tool Sequence Extraction ────────────────────────────────────────────────

/**
 * Extract the sequence of tool calls from messages.
 */
export function extractToolSequence(messages: OpenAIMessage[]): ToolCallEntry[] {
  const sequence: ToolCallEntry[] = []

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.tool_calls) continue
    for (const call of msg.tool_calls) {
      const name = call.function?.name ?? 'unknown'
      let summary: string

      try {
        const args: unknown = call.function?.arguments ? JSON.parse(call.function.arguments) : {}
        summary = TOOL_EXTRACTIONS.get(name)?.summarize(args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {}) ?? ''
      } catch {
        summary = ''
      }

      sequence.push({ name, summary })
    }
  }

  return sequence
}

// ── Prompt Generation ───────────────────────────────────────────────────────

/**
 * Generate a reusable skill prompt from the extraction.
 */
export function generateSkillPrompt(extraction: SkillExtraction): string {
  const lines: string[] = []

  lines.push(`# ${titleCase(extraction.name.replace(/[-_]/g, ' '))}`)
  lines.push('')

  // Description
  if (extraction.description) {
    lines.push(`> ${extraction.description}`)
    lines.push('')
  }

  // Task
  lines.push('## Task')
  lines.push('Complete the following task: $ARGS')
  lines.push('')

  // Approach (derived from tool sequence)
  if (extraction.toolSequence.length > 0) {
    lines.push('## Approach')
    const steps = deduplicateAndSummarize(extraction.toolSequence)
    for (let i = 0; i < steps.length; i++) {
      lines.push(`${i + 1}. ${steps[i]}`)
    }
    lines.push('')
  }

  // Tips based on category
  const tips = CATEGORY_TIPS[extraction.category] ?? []
  if (tips.length > 0) {
    lines.push('## Tips')
    for (const tip of tips) {
      lines.push(`- ${tip}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

function deduplicateAndSummarize(tools: ToolCallEntry[]): string[] {
  // Group consecutive same-tool calls
  const groups: Array<{ name: string; count: number; summaries: string[] }> = []
  for (const t of tools) {
    const last = groups[groups.length - 1]
    if (last && last.name === t.name) {
      last.count++
      if (t.summary) last.summaries.push(t.summary)
    } else {
      groups.push({ name: t.name, count: 1, summaries: t.summary ? [t.summary] : [] })
    }
  }

  return groups.map(g => {
    const action = TOOL_EXTRACTIONS.get(g.name)?.action ?? g.name
    if (g.count === 1) {
      return g.summaries.length > 0 ? `${action} ${g.summaries[0]}` : action
    }
    return `${action} ${g.count} items${g.summaries.length > 0 ? ` (e.g. ${g.summaries[0]})` : ''}`
  })
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, c => c.toUpperCase())
}

// ── Main Extractor ──────────────────────────────────────────────────────────

/**
 * Analyze conversation messages and extract a reusable skill.
 */
export function extractSkill(
  messages: OpenAIMessage[],
  options: ExtractionOptions,
): SkillExtraction {
  const maxMsgs = options.maxMessages ?? 50
  const relevant = messages.slice(-maxMsgs)

  const category = detectCategory(relevant)
  const toolSequence = extractToolSequence(relevant)

  // Build description from the first user message
  const firstUserMsg = relevant.find(m => m.role === 'user')
  const userText = typeof firstUserMsg?.content === 'string' ? firstUserMsg.content : ''
  const description = options.description ?? (userText.slice(0, 100).trim() || `Skill: ${options.name}`)

  const turnCount = relevant.filter(m => m.role === 'user').length

  const extraction: SkillExtraction = {
    name: options.name,
    description,
    category,
    toolSequence,
    messageCount: relevant.length,
    turnCount,
    prompt: '', // set below
  }

  extraction.prompt = generateSkillPrompt(extraction)

  return extraction
}

// ── Serialization ───────────────────────────────────────────────────────────

/**
 * Format the extraction as a markdown file compatible with the skill loader.
 */
export function formatSkillMarkdown(extraction: SkillExtraction): string {
  const frontmatter = [
    '---',
    `name: ${extraction.name}`,
    `description: ${extraction.description}`,
    `version: "1.0"`,
    `category: ${extraction.category}`,
    '---',
    '',
  ].join('\n')

  return frontmatter + extraction.prompt + '\n'
}

/**
 * Save a skill to disk.
 * Returns the file path.
 */
export function saveSkill(cwd: string, extraction: SkillExtraction): string {
  const dir = join(resolve(cwd), '.ovolv999', 'skills')
  mkdirSync(dir, { recursive: true })

  const filePath = join(dir, `${extraction.name}.md`)
  const content = formatSkillMarkdown(extraction)
  writeFileSync(filePath, content, 'utf8')

  return filePath
}

/**
 * Check if a skill already exists.
 */
export function skillExists(cwd: string, name: string): boolean {
  const filePath = join(resolve(cwd), '.ovolv999', 'skills', `${name}.md`)
  return existsSync(filePath)
}
