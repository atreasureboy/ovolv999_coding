/**
 * Thinking Display
 *
 * Formats and manages the display of LLM reasoning/thinking blocks.
 * Supports expandable view, timing display, and trigger detection.
 *
 * Integrates with the existing ThinkingTagFilter which strips <think> blocks
 * from streamed content. This module handles the PRESENTATION of that content.
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface ThinkingBlock {
  /** The raw thinking text */
  content: string
  /** Start timestamp (epoch ms) */
  startTime: number
  /** End timestamp (epoch ms) */
  endTime: number | null
  /** Whether this block is currently expanding */
  isStreaming: boolean
  /** Whether the user has expanded the full view */
  expanded: boolean
  /** Whether this was triggered by an "ultrathink" keyword */
  ultrathink: boolean
}

export interface ThinkingDisplayOptions {
  /** Max chars to show in collapsed view */
  collapsedMaxChars?: number
  /** Whether to show timing */
  showTiming?: boolean
  /** Whether to color ultrathink triggers */
  colorUltrathink?: boolean
  /** Label for the thinking block */
  label?: string
}

export const DEFAULT_OPTIONS: Required<ThinkingDisplayOptions> = {
  collapsedMaxChars: 200,
  showTiming: true,
  colorUltrathink: true,
  label: 'Thinking',
}

// ── Trigger Detection ───────────────────────────────────────────────────────

/**
 * Keywords that trigger extended thinking ("ultrathink" mode).
 * When detected in user input, the LLM is prompted to think harder.
 */
export const ULTRATHINK_TRIGGERS: ReadonlySet<string> = new Set([
  'ultrathink',
  'think hard',
  'think harder',
  'think deeply',
  'megathink',
  'think a lot',
  'reason carefully',
  'reason step by step',
  'think step by step',
  'let\'s think',
])

/**
 * Check if user input contains an ultrathink trigger.
 */
export function hasUltrathinkTrigger(input: string): boolean {
  const lower = input.toLowerCase()
  for (const trigger of ULTRATHINK_TRIGGERS) {
    if (lower.includes(trigger)) return true
  }
  return false
}

/**
 * Find all ultrathink trigger positions in text.
 */
export function findUltrathinkPositions(text: string): Array<{ start: number; end: number; trigger: string }> {
  const lower = text.toLowerCase()
  const positions: Array<{ start: number; end: number; trigger: string }> = []
  for (const trigger of ULTRATHINK_TRIGGERS) {
    let idx = lower.indexOf(trigger)
    while (idx >= 0) {
      positions.push({ start: idx, end: idx + trigger.length, trigger: text.slice(idx, idx + trigger.length) })
      idx = lower.indexOf(trigger, idx + 1)
    }
  }
  return positions.sort((a, b) => a.start - b.start)
}

// ── Rainbow Colorization ────────────────────────────────────────────────────

const RAINBOW_COLORS: ReadonlyArray<number> = [
  196, // red
  202, // orange
  208, // gold
  214, // yellow-gold
  220, // yellow
  226, // bright yellow
  190, // light green
  154, // green-yellow
  118, // bright green
  82,  // green
  46,  // bright green
  51,  // cyan
  45,  // bright blue
  39,  // blue
  33,  // bright blue
  129, // purple
  135, // magenta
  201, // pink
]

/**
 * Apply rainbow colors to text (for ultrathink trigger words).
 */
export function rainbow(text: string): string {
  let result = ''
  for (let i = 0; i < text.length; i++) {
    const color = RAINBOW_COLORS[i % RAINBOW_COLORS.length]
    result += `\x1b[38;5;${color}m${text[i]}`
  }
  result += '\x1b[0m'
  return result
}

/**
 * Colorize ultrathink triggers in user text.
 */
export function colorizeUltrathink(text: string): string {
  const positions = findUltrathinkPositions(text)
  if (positions.length === 0) return text

  let result = ''
  let lastEnd = 0
  for (const pos of positions) {
    result += text.slice(lastEnd, pos.start)
    result += rainbow(pos.trigger)
    lastEnd = pos.end
  }
  result += text.slice(lastEnd)
  return result
}

// ── Thinking Block Formatting ───────────────────────────────────────────────

/**
 * Create a new thinking block (when <think> starts).
 */
export function createThinkingBlock(content = '', ultrathink = false): ThinkingBlock {
  return {
    content,
    startTime: Date.now(),
    endTime: null,
    isStreaming: true,
    expanded: false,
    ultrathink,
  }
}

/**
 * Finalize a thinking block (when </think> is seen or stream ends).
 */
export function finalizeThinkingBlock(block: ThinkingBlock): ThinkingBlock {
  return {
    ...block,
    endTime: Date.now(),
    isStreaming: false,
  }
}

/**
 * Get the duration of a thinking block in seconds.
 */
export function getThinkingDuration(block: ThinkingBlock): number {
  const end = block.endTime ?? Date.now()
  return (end - block.startTime) / 1000
}

/**
 * Truncate text to max chars, adding ellipsis.
 */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const half = Math.floor((maxChars - 3) / 2)
  return text.slice(0, half) + '...' + text.slice(-half)
}

/**
 * Format a thinking block for collapsed display.
 * Shows label + first N chars + timing.
 */
export function formatCollapsed(block: ThinkingBlock, options: ThinkingDisplayOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const icon = block.ultrathink ? '✻' : '∴'
  const label = block.isStreaming
    ? `${icon} ${opts.label}...`
    : `${icon} ${opts.label}`

  let result = `\x1b[2m\x1b[36m${label}\x1b[0m`

  if (opts.showTiming && !block.isStreaming && block.endTime) {
    const duration = getThinkingDuration(block)
    result += ` \x1b[2m(thought for ${duration.toFixed(1)}s)\x1b[0m`
  }

  if (block.content.trim()) {
    const preview = truncate(block.content.replace(/\n/g, ' ').trim(), opts.collapsedMaxChars)
    result += `\n\x1b[2m${preview}\x1b[0m`
  }

  if (!block.isStreaming) {
    result += '\n\x1b[2m(Ctrl+O to expand)\x1b[0m'
  }

  return result
}

/**
 * Format a thinking block for expanded display.
 * Shows full content with a header.
 */
export function formatExpanded(block: ThinkingBlock, options: ThinkingDisplayOptions = {}): string {
  const opts = { ...DEFAULT_OPTIONS, ...options }
  const icon = block.ultrathink ? '✻' : '∴'
  const lines: string[] = []

  const header = block.isStreaming
    ? `${icon} ${opts.label} (streaming...)`
    : `${icon} ${opts.label}`
  lines.push(`\x1b[36m\x1b[1m${header}\x1b[0m`)

  if (opts.showTiming && !block.isStreaming && block.endTime) {
    const duration = getThinkingDuration(block)
    lines.push(`\x1b[2mDuration: ${duration.toFixed(2)}s · ${block.content.length} chars\x1b[0m`)
  }

  lines.push('') // blank line
  lines.push('\x1b[2m' + block.content + '\x1b[0m')
  lines.push('') // blank line
  lines.push('\x1b[2m── End Thinking ──\x1b[0m')

  return lines.join('\n')
}

/**
 * Format a thinking block (auto-selects collapsed/expanded).
 */
export function formatThinking(block: ThinkingBlock, options: ThinkingDisplayOptions = {}): string {
  return block.expanded
    ? formatExpanded(block, options)
    : formatCollapsed(block, options)
}

// ── Multi-Block Management ──────────────────────────────────────────────────

/**
 * Manager for multiple thinking blocks in a conversation.
 */
export class ThinkingDisplayManager {
  private blocks: Map<string, ThinkingBlock> = new Map()
  private order: string[] = []
  private options: ThinkingDisplayOptions

  constructor(options: ThinkingDisplayOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options }
  }

  /**
   * Start a new thinking block.
   */
  startBlock(id: string, ultrathink = false): ThinkingBlock {
    const block = createThinkingBlock('', ultrathink)
    this.blocks.set(id, block)
    if (!this.order.includes(id)) this.order.push(id)
    return block
  }

  /**
   * Append content to a thinking block.
   */
  appendContent(id: string, content: string): void {
    const block = this.blocks.get(id)
    if (block) block.content += content
  }

  /**
   * Finalize a thinking block.
   */
  endBlock(id: string): ThinkingBlock | null {
    const block = this.blocks.get(id)
    if (!block) return null
    const finalized = finalizeThinkingBlock(block)
    this.blocks.set(id, finalized)
    return finalized
  }

  /**
   * Toggle expanded state.
   */
  toggleExpand(id: string): void {
    const block = this.blocks.get(id)
    if (block) block.expanded = !block.expanded
  }

  /**
   * Expand all blocks.
   */
  expandAll(): void {
    for (const block of this.blocks.values()) block.expanded = true
  }

  /**
   * Collapse all blocks.
   */
  collapseAll(): void {
    for (const block of this.blocks.values()) block.expanded = false
  }

  /**
   * Get all blocks in order.
   */
  getAll(): ThinkingBlock[] {
    return this.order.map(id => this.blocks.get(id)!).filter(Boolean)
  }

  /**
   * Get total thinking time across all blocks.
   */
  getTotalDuration(): number {
    return this.getAll().reduce((sum, b) => sum + getThinkingDuration(b), 0)
  }

  /**
   * Get total character count across all blocks.
   */
  getTotalChars(): number {
    return this.getAll().reduce((sum, b) => sum + b.content.length, 0)
  }

  /**
   * Clear all blocks.
   */
  clear(): void {
    this.blocks.clear()
    this.order = []
  }

  /**
   * Format a summary of all thinking blocks.
   */
  formatSummary(): string {
    const blocks = this.getAll()
    if (blocks.length === 0) return ''

    const lines: string[] = [`\x1b[2m── Thinking Summary (${blocks.length} block(s)) ──\x1b[0m`]
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      const duration = getThinkingDuration(block).toFixed(1)
      const chars = block.content.length
      const ultra = block.ultrathink ? ' ✻ultrathink' : ''
      lines.push(`\x1b[2m  #${i + 1}: ${duration}s · ${chars} chars${ultra}\x1b[0m`)
    }

    const totalDuration = this.getTotalDuration().toFixed(1)
    const totalChars = this.getTotalChars()
    lines.push(`\x1b[2m  Total: ${totalDuration}s · ${totalChars} chars\x1b[0m`)

    return lines.join('\n')
  }
}
