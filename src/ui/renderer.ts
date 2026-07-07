/**
 * Terminal UI Renderer — clean, minimal, professional
 *
 * Design principles (Claude Code inspired):
 * - No giant ASCII art — small clean logo
 * - Compact tool calls: icon + name + preview on one line
 * - Streaming text: clean, no left-border noise
 * - Results: dimmed, indented, truncated gracefully
 * - Consistent color: each tool type has one color
 * - Minimal chrome — let content shine
 */

import { createWriteStream } from 'fs'
import { str } from '../core/strings.js'

// ── ANSI ────────────────────────────────────────────────────

const R = '\x1b[0m'        // Reset
const B = '\x1b[1m'        // Bold
const D = '\x1b[2m'        // Dim

const C = {
  red:    '\x1b[31m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  blue:   '\x1b[34m',
  purple: '\x1b[35m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  bred:   '\x1b[91m',
  bgreen: '\x1b[92m',
  byellow:'\x1b[93m',
  bblue:  '\x1b[94m',
  bpurple:'\x1b[95m',
  bcyan:  '\x1b[96m',
  bgray:  '\x1b[37m',
  white:  '\x1b[97m',
}

// ── Spinner ─────────────────────────────────────────────────

const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
const VERBS = ['Thinking','Analyzing','Processing','Computing','Reasoning','Working','Exploring','Building']

// ── Tool metadata ───────────────────────────────────────────

const TOOL_STYLE: Record<string, { icon: string; color: string }> = {
  Bash:          { icon: '$',  color: C.byellow },
  Read:          { icon: '●',  color: C.bcyan },
  Write:         { icon: '✎',  color: C.bgreen },
  Edit:          { icon: '✎',  color: C.bblue },
  Glob:          { icon: '◇',  color: C.bpurple },
  Grep:          { icon: '⌕',  color: C.bpurple },
  WebFetch:      { icon: '↗',  color: C.cyan },
  WebSearch:     { icon: '⌕',  color: C.cyan },
  TodoWrite:     { icon: '☑',  color: C.bgreen },
  Agent:         { icon: '⊕',  color: C.bpurple },
  ShellSession:  { icon: '⌁',  color: C.bred },
  TmuxSession:   { icon: '⌁',  color: C.bred },
  load_skill:    { icon: '◆',  color: C.bblue },
  memory_write:  { icon: '✦',  color: C.bgreen },
  memory_search: { icon: '✦',  color: C.bcyan },
  memory_recall: { icon: '✦',  color: C.byellow },
}

function getToolStyle(name: string) {
  return TOOL_STYLE[name] ?? { icon: '·', color: C.white }
}

// ── Renderer ────────────────────────────────────────────────

export class Renderer {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null
  private spinnerFrame = 0
  private spinnerVerbIdx = 0
  private termWidth: number
  private isTTY: boolean
  private writeFn: (s: string) => void
  private streamingActive = false
  private streamFirstLine = true

  constructor(options?: { stream?: NodeJS.WritableStream }) {
    const stream = options?.stream ?? process.stdout
    this.writeFn = (s: string) => { stream.write(s) }
    this.isTTY = (stream as NodeJS.WriteStream).isTTY === true
    this.termWidth = this.isTTY ? ((stream as NodeJS.WriteStream).columns ?? 80) : 80
    if (this.isTTY) {
      (stream as NodeJS.WriteStream).on?.('resize', () => {
        this.termWidth = (stream as NodeJS.WriteStream).columns ?? 80
      })
    }
  }

  static forFile(filePath: string): Renderer {
    const fileStream = createWriteStream(filePath, { flags: 'a' })
    fileStream.on('error', () => {})
    return new Renderer({ stream: fileStream as unknown as NodeJS.WritableStream })
  }

  private write(s: string): void { this.writeFn(s) }

  // ── Banner ────────────────────────────────────────────────

  banner(version: string, model: string): void {
    this.write('\n')
    this.write(`  ${B}${C.bpurple}ovolv999${R} ${D}${C.gray}v${version}${R}\n`)
    this.write(`  ${D}model: ${C.bcyan}${model}${R}${D} · Think-Act-Observe Engine${R}\n`)
    this.write('\n')
  }

  // ── User message ──────────────────────────────────────────

  humanPrompt(text: string): void {
    const short = text.length > 200 ? text.slice(0, 197) + '...' : text
    this.write(`\n  ${C.bblue}❯${R} ${B}${C.white}${short}${R}\n`)
  }

  // ── Streaming LLM output ──────────────────────────────────

  beginAssistantText(): void {
    this.streamingActive = true
    this.streamFirstLine = true
  }

  streamToken(token: string): void {
    if (!this.streamingActive) this.beginAssistantText()
    this.write(token)
  }

  endAssistantText(): void {
    if (this.streamingActive) {
      this.write('\n\n')
      this.streamingActive = false
    }
  }

  // ── Tool calls ────────────────────────────────────────────

  toolStart(toolName: string, input: Record<string, unknown>): void {
    const style = getToolStyle(toolName)
    const preview = this.formatPreview(toolName, input)
    this.write(`  ${style.color}${style.icon}${R} ${B}${style.color}${toolName}${R}`)
    if (preview) {
      this.write(` ${D}${C.gray}${preview}${R}`)
    }
    this.write('\n')
  }

  toolResult(toolName: string, result: string, isError: boolean): void {
    if (isError) {
      const lines = result.split('\n').slice(0, 5)
      for (const line of lines) {
        this.write(`  ${C.red}  ${line}${R}\n`)
      }
      return
    }

    // Compact result — show first few lines dimmed
    const lines = result.split('\n').filter(l => l.trim())
    const shown = lines.slice(0, 4)
    const hidden = lines.length - shown.length

    for (const line of shown) {
      const trimmed = line.length > 120 ? line.slice(0, 117) + '...' : line
      this.write(`  ${D}  ${trimmed}${R}\n`)
    }
    if (hidden > 0) {
      this.write(`  ${D}  ... ${hidden} more line${hidden !== 1 ? 's' : ''}${R}\n`)
    }
  }

  private formatPreview(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        const cmd = str(input.command).trim()
        return cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd
      }
      case 'Read': {
        const fp = str(input.file_path)
        const off = input.offset ? ` +${str(input.offset)}` : ''
        return `${fp}${off}`
      }
      case 'Write': {
        const fp = str(input.file_path)
        const lines = str(input.content).split('\n').length
        return `${fp} (${lines} lines)`
      }
      case 'Edit': {
        const fp = str(input.file_path)
        return fp
      }
      case 'Glob': {
        return str(input.pattern)
      }
      case 'Grep': {
        const p = str(input.pattern)
        const g = input.include ? ` [${str(input.include)}]` : input.glob ? ` [${str(input.glob)}]` : ''
        return `/${p}/${g}`
      }
      case 'Agent': {
        const t = input.subagent_type ? str(input.subagent_type) : ''
        const d = input.description ? str(input.description) : ''
        return t ? `[${t}] ${d}` : d
      }
      default:
        return ''
    }
  }

  // ── Spinner ───────────────────────────────────────────────

  startSpinner(_initialVerb?: string): void {
    if (!this.isTTY) return
    if (this.spinnerInterval) this.stopSpinner()
    this.spinnerVerbIdx = Math.floor(Math.random() * VERBS.length)
    this.renderSpinner()
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % FRAMES.length
      if (this.spinnerFrame % 20 === 0) {
        this.spinnerVerbIdx = (this.spinnerVerbIdx + 1) % VERBS.length
      }
      this.renderSpinner()
    }, 60)
  }

  private renderSpinner(): void {
    const f = FRAMES[this.spinnerFrame]
    const v = VERBS[this.spinnerVerbIdx]
    this.write(`\r${C.bpurple}${f}${R} ${D}${v}...${R}`)
  }

  stopSpinner(): void {
    if (!this.spinnerInterval) return
    clearInterval(this.spinnerInterval)
    this.spinnerInterval = null
    if (this.isTTY) {
      this.write('\r\x1b[K')  // clear line
    }
  }

  // ── Status messages ───────────────────────────────────────

  info(msg: string): void {
    this.write(`  ${D}${msg}${R}\n`)
  }

  success(msg: string): void {
    this.write(`  ${C.bgreen}✓${R} ${msg}\n`)
  }

  error(msg: string): void {
    this.write(`  ${C.bred}✗${R} ${C.red}${msg}${R}\n`)
  }

  warn(msg: string): void {
    if (msg.trim()) {
      this.write(`  ${C.byellow}⚠${R} ${msg}\n`)
    }
  }

  // ── Sub-agent ─────────────────────────────────────────────

  agentStart(description: string, agentType = 'general-purpose'): void {
    const label = agentType !== 'general-purpose' ? ` ${D}[${agentType}]${R}` : ''
    this.write(`\n  ${C.bpurple}⊕${R} ${B}Agent${R}${label} ${D}${description}${R}\n`)
  }

  agentDone(description: string, success: boolean): void {
    const icon = success ? `${C.bgreen}✓${R}` : `${C.bred}✗${R}`
    this.write(`  ${icon} ${D}done${R}\n`)
  }

  agentSummary(agentType: string, description: string, summary: string): void {
    const lines = summary.split('\n').filter(l => l.trim()).slice(0, 6)
    for (const line of lines) {
      this.write(`  ${D}  ${line}${R}\n`)
    }
  }

  agentHeartbeat(agentType: string, description: string, elapsedSec: number): void {
    const mins = Math.floor(elapsedSec / 60)
    const secs = elapsedSec % 60
    const elapsed = mins > 0 ? `${mins}m${secs}s` : `${secs}s`
    this.write(`  ${C.yellow}⏳${R} ${D}[${agentType}] running ${elapsed}...${R}\n`)
  }

  // ── Plan mode ─────────────────────────────────────────────

  planModeStart(): void {
    this.write(`\n  ${C.bblue}◇ PLAN MODE${R} ${D}(read-only)${R}\n`)
  }

  planConfirmPrompt(): void {
    this.write(`\n  ${C.byellow}?${R} Proceed? ${D}[y/N]${R} `)
  }

  // ── Context ───────────────────────────────────────────────

  compactStart(tokenCount: number): void {
    this.write(`\n  ${C.yellow}⟳${R} ${D}Context ${Math.round(tokenCount / 1000)}k tokens — compacting...${R}\n`)
  }

  compactDone(originalTokens: number, summaryTokens: number): void {
    const saved = Math.round((1 - summaryTokens / originalTokens) * 100)
    this.write(`  ${C.bgreen}✓${R} ${D}${Math.round(originalTokens / 1000)}k → ${Math.round(summaryTokens / 1000)}k (${saved}% saved)${R}\n`)
  }

  contextWarning(tokens: number, maxTokens: number, pct: number): void {
    const p = Math.round(pct * 100)
    this.write(`\n  ${C.byellow}⚠${R} ${D}Context ${p}% · ${Math.round(tokens / 1000)}k/${Math.round(maxTokens / 1000)}k tokens${R}\n`)
  }

  // ── Interrupt ─────────────────────────────────────────────

  writeInterruptPrompt(): void {
    this.write('\n\x07')
    this.write(`  ${C.byellow}⚡ Interrupted${R}\n`)
    this.write(`  ${D}Type feedback + Enter to inject, or just Enter to resume${R}\n`)
    this.write(`  ${C.byellow}❯${R} `)
  }

  interruptInjected(msg: string): void {
    this.write(`  ${C.byellow}⚡${R} ${D}Injected:${R} ${C.white}${msg.slice(0, 120)}${msg.length > 120 ? '...' : ''}${R}\n`)
  }

  // ── REPL prompt ───────────────────────────────────────────

  writePrompt(): void {
    this.write(`\n${C.bblue}❯${R} `)
  }

  newline(): void {
    this.write('\n')
  }
}
