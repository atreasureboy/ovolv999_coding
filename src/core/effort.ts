/**
 * Effort System
 *
 * Control the depth of reasoning and analysis.
 * Higher effort = more thinking, deeper analysis, slower responses.
 * Lower effort = faster, more direct answers.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'maximum'

export const EFFORT_LEVELS: readonly EffortLevel[] = ['minimal', 'low', 'medium', 'high', 'maximum']

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && EFFORT_LEVELS.some(level => level === value)
}

export function nextEffort(level: EffortLevel): EffortLevel {
  return EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(level) + 1) % EFFORT_LEVELS.length]
}

export interface EffortConfig {
  level: EffortLevel
  thinkingTokens: number
  maxSearchResults: number
  verificationDepth: 'none' | 'quick' | 'thorough'
  explanationDetail: 'minimal' | 'normal' | 'detailed'
  multiApproach: boolean
  edgeCaseAnalysis: boolean
}

// ── Presets ─────────────────────────────────────────────────────────────────

export const EFFORT_PRESETS: Record<EffortLevel, EffortConfig> = {
  minimal: {
    level: 'minimal',
    thinkingTokens: 0,
    maxSearchResults: 3,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  low: {
    level: 'low',
    thinkingTokens: 500,
    maxSearchResults: 5,
    verificationDepth: 'none',
    explanationDetail: 'minimal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  medium: {
    level: 'medium',
    thinkingTokens: 2000,
    maxSearchResults: 10,
    verificationDepth: 'quick',
    explanationDetail: 'normal',
    multiApproach: false,
    edgeCaseAnalysis: false,
  },
  high: {
    level: 'high',
    thinkingTokens: 5000,
    maxSearchResults: 20,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
    multiApproach: true,
    edgeCaseAnalysis: true,
  },
  maximum: {
    level: 'maximum',
    thinkingTokens: 10000,
    maxSearchResults: 50,
    verificationDepth: 'thorough',
    explanationDetail: 'detailed',
    multiApproach: true,
    edgeCaseAnalysis: true,
  },
}

// ── State ───────────────────────────────────────────────────────────────────

let currentEffort: EffortLevel = 'medium'

export function getCurrentEffort(): EffortLevel {
  return currentEffort
}

export function setEffort(level: EffortLevel): EffortConfig {
  currentEffort = level
  return getEffortConfig(level)
}

export function getEffortConfig(level?: EffortLevel): EffortConfig {
  return EFFORT_PRESETS[level ?? currentEffort]
}

export function cycleEffort(): EffortLevel {
  const next = nextEffort(currentEffort)
  currentEffort = next
  return next
}

// ── Prompt Generation ───────────────────────────────────────────────────────

export function getEffortPrompt(level?: EffortLevel): string {
  const config = getEffortConfig(level ?? currentEffort)

  const parts: string[] = []

  switch (config.explanationDetail) {
    case 'minimal':
      parts.push('Be extremely concise. Only output code or the direct answer.')
      break
    case 'normal':
      parts.push('Provide clear, direct answers with necessary context.')
      break
    case 'detailed':
      parts.push('Provide thorough explanations. Include context, trade-offs, and alternatives.')
      break
  }

  if (config.multiApproach) {
    parts.push('Consider multiple approaches. Present alternatives with trade-offs.')
  }

  if (config.edgeCaseAnalysis) {
    parts.push('Analyze edge cases: null, empty, boundary values, concurrent access.')
  }

  switch (config.verificationDepth) {
    case 'none':
      break
    case 'quick':
      parts.push('Quickly verify your changes by reading the result.')
      break
    case 'thorough':
      parts.push('Thoroughly verify changes. Read results, run tests if possible.')
      break
  }

  return parts.join(' ')
}

// ── Formatting ──────────────────────────────────────────────────────────────

const EFFORT_ICONS: Record<EffortLevel, string> = {
  minimal: '○',
  low: '◐',
  medium: '●',
  high: '◉',
  maximum: '★',
}

export function formatEffort(level?: EffortLevel): string {
  const l = level ?? currentEffort
  const config = getEffortConfig(l)
  const icon = EFFORT_ICONS[l]
  return `${icon} ${l} (guidance: ${config.explanationDetail}, verify: ${config.verificationDepth})`
}

export function formatEffortList(activeLevel: EffortLevel = currentEffort): string {
  const lines: string[] = ['Effort Levels:']
  for (const level of EFFORT_LEVELS) {
    const config = EFFORT_PRESETS[level]
    const icon = EFFORT_ICONS[level]
    const active = level === activeLevel ? ' ← active' : ''
    lines.push(`  ${icon} ${level.padEnd(8)} guidance=${config.explanationDetail} verify=${config.verificationDepth}${active}`)
  }
  return lines.join('\n')
}
