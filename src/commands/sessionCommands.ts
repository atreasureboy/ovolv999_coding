import type { Command } from './index.js'
import { text } from './results.js'
import type { SlashCommandResult } from './index.js'
import { estimateTokens, calculateContextState, microCompact } from '../core/compact.js'
import type { OpenAIMessage } from '../core/types.js'
import { copyToClipboard } from '../utils/clipboard.js'

const exit = (): SlashCommandResult => ({ type: 'exit' })

function previewMessage(msg: OpenAIMessage, max: number): string {
  const raw =
    typeof msg.content === 'string'
      ? msg.content
      : JSON.stringify(msg.content ?? msg.tool_calls ?? '')
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, Math.max(0, max - 1)) + '…'
}

function roleLabel(role: string): string {
  if (role === 'user') return 'You'
  if (role === 'assistant') return 'AI'
  if (role === 'tool') return 'Tool'
  if (role === 'system') return 'Sys'
  return role
}

export const sessionCommands: Command[] = [
  {
    name: 'exit',
    description: 'Exit the REPL',
    aliases: ['quit', 'q'],
    handler: () => exit(),
  },
  {
    name: 'clear',
    description: 'Clear conversation history',
    handler: (_args, ctx) => {
      ctx.setHistory([])
      return { type: 'clear-history' }
    },
  },
  {
    name: 'reset',
    description: 'Reset everything: history + cost + context (fresh start)',
    handler: (_args, ctx) => {
      ctx.setHistory([])
      ctx.engine.getCostTracker().reset()
      return { type: 'clear-history' }
    },
  },
  {
    name: 'history',
    description: 'Show recent messages (default 10) and current session stats',
    usage: '/history [N]',
    handler: (args, ctx) => {
      const trimmed = args.trim()
      const parsed = trimmed ? Number.parseInt(trimmed, 10) : 10
      const n = Number.isInteger(parsed) && parsed > 0 ? parsed : 10
      const total = ctx.history.length
      const tokens = estimateTokens(ctx.history)
      const lines: string[] = []
      if (total === 0) {
        lines.push('No messages in this session yet.')
      } else {
        const recent = ctx.history.slice(-n)
        const skipped = total - recent.length
        if (skipped > 0) lines.push(`Showing last ${recent.length} of ${total} messages:`)
        else lines.push(`Showing all ${total} messages:`)
        for (const msg of recent) {
          lines.push('  [' + roleLabel(msg.role).padEnd(4) + '] ' + previewMessage(msg, 80))
        }
      }
      lines.push('', `Session: ${total} messages, ~${tokens.toLocaleString()} tokens estimated.`)
      return text(lines.join('\n'))
    },
  },
  {
    name: 'compact',
    description: 'Summarize conversation to save context (manual trigger)',
    usage: '/compact [optional instructions]',
    aliases: ['c'],
    handler: (args, ctx) => {
      if (ctx.history.length < 4) {
        return text('Not enough messages to compact (need at least 4).')
      }
      ctx.renderer.warn('Compacting conversation...')
      const mc = microCompact([...ctx.history])
      if (mc.compacted) {
        ctx.setHistory(mc.messages)
        return text(
          `Micro-compacted: cleared ${mc.toolsCleared} old tool results (${mc.tokensBefore}→${mc.tokensAfter} tokens). Full LLM compaction will trigger automatically at 85% pressure.`,
        )
      }
      return text(
        'Nothing to micro-compact. Full LLM summarization will trigger automatically at 85% context pressure.',
      )
    },
  },
  {
    name: 'cost',
    description: 'Show token usage and cost summary',
    aliases: ['co', '$'],
    handler: (_args, ctx) => {
      const tracker = ctx.engine.getCostTracker()
      if (tracker.getTotalAPICalls() === 0) {
        return text('No API calls made yet in this session.')
      }
      return text(tracker.formatSummary())
    },
  },
  {
    name: 'context',
    description: 'Show context window usage breakdown',
    aliases: ['ctx'],
    usage: '/context [top N]  (show top N token consumers)',
    handler: (args, ctx) => {
      const state = calculateContextState(ctx.history)
      const bar_len = 30
      const filled = Math.round(state.pct * bar_len)
      const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(bar_len - filled)
      const pct_str = (state.pct * 100).toFixed(1)
      const status = state.shouldCompact ? '!! COMPACTING' : state.shouldWarn ? '! HIGH' : 'OK'
      const lines: string[] = [
        'Context Window:',
        '  ' + bar + ' ' + pct_str + '%  ' + status,
        '  Tokens: ' +
          state.currentTokens.toLocaleString() +
          ' / ' +
          state.maxTokens.toLocaleString(),
        '  Strategy: ' + state.strategy,
        '  Messages: ' + ctx.history.length,
      ]
      const topN = args.trim()
        ? Math.min(20, Math.max(1, parseInt(args.trim(), 10) || 5))
        : state.pct > 0.5
          ? 5
          : 0
      if (topN > 0 && ctx.history.length > 0) {
        const consumers = ctx.history
          .map((m, i) => {
            const content =
              typeof m.content === 'string'
                ? m.content
                : JSON.stringify(m.content ?? m.tool_calls ?? '')
            return {
              idx: i,
              role: m.role,
              tokens: Math.ceil(content.length / 4),
              preview: content.slice(0, 60).replace(/\n/g, ' '),
            }
          })
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, topN)
        lines.push('', 'Top token consumers:')
        for (const c of consumers) {
          lines.push(
            `  [${c.idx.toString().padStart(3)}] ${c.role.padEnd(9)} ${c.tokens.toString().padStart(6)} tok  ${c.preview}${c.preview.length >= 60 ? '…' : ''}`,
          )
        }
      }
      return text(lines.join('\n'))
    },
  },
  {
    name: 'resume',
    description: 'List saved sessions, or resume one by name/prefix/path',
    usage: '/resume [session_name]',
    handler: (args, ctx) => {
      const name = args.trim()
      if (!name) {
        return text(ctx.getSessionsText?.() ?? 'No saved sessions found.')
      }
      if (!ctx.loadSession) {
        return text(
          'In-session resume is not available in this context. Use ovolv999 --resume <session_name>  or  ovolv999 --continue from the command line.',
        )
      }
      const loaded = ctx.loadSession(name)
      if (!loaded) {
        return text(
          `Session not found: "${name}". Use /resume with no args to list available sessions.`,
        )
      }
      ctx.setHistory(loaded)
      return text(`Resumed session: ${loaded.length} messages loaded.`)
    },
  },
  {
    name: 'sessions',
    description: 'List saved sessions for this project',
    handler: (_args, ctx) => text(ctx.getSessionsText?.() ?? 'No saved sessions found.'),
  },
  {
    name: 'status',
    description: 'Show current session status',
    aliases: ['st', 'info'],
    handler: (_args, ctx) => {
      const cost = ctx.engine.getCostTracker()
      const state = calculateContextState(ctx.history)
      const fh = ctx.engine.getFileHistory()
      const mgr = ctx.engine.getBackgroundTaskManager()
      const tasks = mgr.listTasks()
      const running = tasks.filter((t) => t.status === 'running').length
      const lines = [
        'Model: ' + ctx.engine.getModel(),
        'Messages: ' + ctx.history.length,
        'Context: ' +
          (state.pct * 100).toFixed(0) +
          '% (' +
          state.currentTokens.toLocaleString() +
          '/' +
          state.maxTokens.toLocaleString() +
          ' tokens)',
        'API calls: ' + cost.getTotalAPICalls(),
        'Cost: $' + cost.getTotalCost().toFixed(4),
        'Plan mode: ' + (ctx.engine.isPlanMode() ? 'ON' : 'OFF'),
      ]
      if (fh) {
        const files = fh.getEditedFiles()
        if (files.length > 0) lines.push('Files edited: ' + files.length)
      }
      if (tasks.length > 0)
        lines.push('Background tasks: ' + tasks.length + ' (' + running + ' running)')
      return text('Session Status:\n  ' + lines.join('\n  '))
    },
  },
  {
    name: 'search',
    description: 'Search conversation history for a keyword',
    usage: '/search <keyword>',
    handler: (args, ctx) => {
      const query = args.trim().toLowerCase()
      if (!query) return text('Usage: /search <keyword>')
      if (ctx.history.length === 0) return text('No conversation to search.')
      const results: Array<{
        role: string
        preview: string
        idx: number
      }> = []
      for (let i = 0; i < ctx.history.length; i++) {
        const msg = ctx.history[i]
        if (msg.role === 'system') continue
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
        if (content.toLowerCase().includes(query)) {
          const preview = content.slice(0, 100).replace(/\n/g, ' ')
          results.push({ role: msg.role, preview, idx: i })
        }
      }
      if (results.length === 0) return text(`No matches for "${args.trim()}".`)
      const lines = results
        .slice(0, 15)
        .map((r) => `  [${r.idx}] ${r.role}: ${r.preview}${r.preview.length >= 100 ? '...' : ''}`)
      let out = `Found ${results.length} match${results.length === 1 ? '' : 'es'} for "${args.trim()}":\n`
      out += lines.join('\n')
      if (results.length > 15) out += `\n  ... and ${results.length - 15} more`
      return text(out)
    },
  },
  {
    name: 'copy',
    description: 'Copy last assistant reply to clipboard',
    handler: (_args, ctx) => {
      for (let i = ctx.history.length - 1; i >= 0; i--) {
        const m = ctx.history[i]
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
          const ok = copyToClipboard(m.content)
          return ok
            ? text('✓ Copied to clipboard')
            : text('⚠ No clipboard tool found (install xclip or wl-copy)')
        }
      }
      return text('No assistant reply to copy')
    },
  },
  {
    name: 'retry',
    description: 'Retry the last turn (re-submit last prompt)',
    handler: (_args, ctx) => {
      if (ctx.history.length === 0) return text('No previous turn to retry')
      for (let i = ctx.history.length - 1; i >= 0; i--) {
        const m = ctx.history[i]
        if (m.role === 'user' && typeof m.content === 'string') {
          ctx.runPrompt(m.content)
          return { type: 'noop' }
        }
      }
      return text('No previous prompt found')
    },
  },
  {
    name: 'stats',
    description: 'Show comprehensive session statistics (messages, tokens, tools, files)',
    handler: async (_args, ctx) => {
      const { analyzeSession, formatSessionStats } = await import('../core/sessionStats.js')
      const stats = analyzeSession(ctx.history)
      return text(formatSessionStats(stats))
    },
  },
  {
    name: 'cmd-history',
    aliases: ['hist', 'cmdhist'],
    description:
      'Search past commands/prompts. Usage: /cmd-history [search <query> | stats | clear]',
    handler: async (args, ctx) => {
      const {
        getProjectHistoryPath,
        loadHistory,
        searchHistory,
        getHistoryStats,
        formatHistoryResults,
        formatHistoryStats,
        clearHistory,
      } = await import('../core/commandHistory.js')
      const path = getProjectHistoryPath(ctx.cwd)
      const parts = args.trim().split(/\s+/)
      const sub = parts[0] ?? 'recent'
      if (sub === 'stats') {
        const store = loadHistory(path)
        return text(formatHistoryStats(getHistoryStats(store)))
      }
      if (sub === 'clear') {
        const count = clearHistory(path)
        return text(`✓ Cleared ${count} history entries`)
      }
      if (sub === 'search') {
        const query = parts.slice(1).join(' ')
        const store = loadHistory(path)
        const results = searchHistory(store, query)
        return text(formatHistoryResults(results))
      }
      if (sub === 'recent' || !sub) {
        const store = loadHistory(path)
        const results = searchHistory(store, '', { limit: 20 })
        return text(formatHistoryResults(results))
      }
      return text(`Usage: /cmd-history [search <query> | stats | clear]`)
    },
  },
]
