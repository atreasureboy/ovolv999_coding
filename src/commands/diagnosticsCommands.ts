import type { Command } from './index.js'
import { text } from './results.js'
import { calculateContextState } from '../core/compact.js'
import { resolve } from 'path'

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `... (${s.length - max} more chars)`
}

export const diagnosticsCommands: Command[] = [
  {
    name: 'doctor',
    description: 'Run health diagnostics',
    handler: (_args, ctx) => {
      const OK = '\x1b[32m\u2713\x1b[0m'
      const FAIL = '\x1b[31m\u2717\x1b[0m'
      const INFO = '\x1b[36mi\x1b[0m'
      const checks: string[] = []
      const anthropicBaseURL = process.env.ANTHROPIC_BASE_URL
      const anthropicApiKey = process.env.ANTHROPIC_AUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY
      const isMiniMax = Boolean(
        anthropicApiKey &&
        anthropicBaseURL &&
        /^https:\/\/api\.(?:minimax\.io|minimaxi\.com)\/anthropic\/?$/i.test(anthropicBaseURL),
      )
      if (isMiniMax) {
        checks.push('  ' + OK + ' Provider: MiniMax (Anthropic-compatible endpoint)')
        checks.push('  ' + OK + ' API key: set (ANTHROPIC_AUTH_TOKEN)')
        checks.push('  ' + INFO + ' Base URL: ' + anthropicBaseURL)
      } else {
        const apiKey = process.env.OPENAI_API_KEY
        if (apiKey && apiKey.length > 10) {
          checks.push(
            '  ' + OK + ' API key: set (' + apiKey.slice(0, 6) + '...' + apiKey.slice(-4) + ')',
          )
        } else {
          checks.push('  ' + FAIL + ' API key: NOT SET (export OPENAI_API_KEY=...)')
        }
        const baseURL = process.env.OPENAI_BASE_URL
        checks.push('  ' + INFO + ' Base URL: ' + (baseURL || 'default (OpenAI)'))
      }
      checks.push('  ' + INFO + ' Model: ' + ctx.engine.getModel())
      checks.push('  ' + INFO + ' CWD: ' + ctx.cwd)
      checks.push('  ' + INFO + ' Session: ' + (ctx.sessionDir || 'none'))
      checks.push('  ' + INFO + ' Plan mode: ' + (ctx.engine.isPlanMode() ? 'ON' : 'OFF'))
      const cost = ctx.engine.getCostTracker()
      checks.push('  ' + INFO + ' API calls: ' + cost.getTotalAPICalls())
      if (cost.getTotalAPICalls() > 0) {
        checks.push('  ' + INFO + ' Cost: $' + cost.getTotalCost().toFixed(4))
      }
      const fh = ctx.engine.getFileHistory()
      if (fh) {
        const files = fh.getEditedFiles()
        checks.push('  ' + INFO + ' File history: ' + files.length + ' file(s) tracked')
      }
      const mgr = ctx.engine.getBackgroundTaskManager()
      const tasks = mgr.listTasks()
      if (tasks.length > 0) {
        const running = tasks.filter((t) => t.status === 'running').length
        checks.push(
          '  ' + INFO + ' Background tasks: ' + tasks.length + ' (' + running + ' running)',
        )
      }
      const state = calculateContextState(ctx.history)
      const pct = (state.pct * 100).toFixed(0)
      checks.push(
        '  ' +
          INFO +
          ' Context: ' +
          pct +
          '% used (' +
          state.currentTokens.toLocaleString() +
          '/' +
          state.maxTokens.toLocaleString() +
          ' tokens)',
      )
      checks.push('  ' + INFO + ' Node: ' + process.version)
      checks.push('  ' + INFO + ' Platform: ' + process.platform + ' ' + process.arch)
      return text('Health Check:\n' + checks.join('\n'))
    },
  },
  {
    name: 'audit',
    description:
      'Validate all .ovolv999/ configuration files (keybindings, styles, workflows, skills)',
    handler: async (_args, ctx) => {
      const { runDoctorChecks, formatDoctorReport } = await import('../utils/doctor.js')
      const report = runDoctorChecks(ctx.cwd)
      return text(formatDoctorReport(report))
    },
  },
  {
    name: 'suggest',
    aliases: ['suggestions'],
    description: 'Show proactive suggestions based on current context',
    handler: async (_args, ctx) => {
      const { generateSuggestions, enrichContext, formatSuggestionList } =
        await import('../core/suggestions.js')
      const enriched = enrichContext(
        {
          conversationLength: ctx.history.length,
          lastTurnCompleted: true,
          recentToolResults: [],
        },
        ctx.cwd,
      )
      const suggestions = generateSuggestions(enriched)
      if (suggestions.length === 0) {
        return text('No suggestions at this time.')
      }
      const list = formatSuggestionList(suggestions)
      const hints = suggestions
        .map(
          (
            s: {
              actionCommand?: string
              actionPrompt?: string
              label: string
            },
            i: number,
          ) => {
            if (s.actionCommand) return `  ${i + 1}. Run: ${s.actionCommand}`
            if (s.actionPrompt) return `  ${i + 1}. Prompt: "${s.actionPrompt.slice(0, 60)}"`
            return null
          },
        )
        .filter(Boolean)
        .join('\n')
      return text(`${list}\n\n${hints}`)
    },
  },
  {
    name: 'scan',
    description: 'Scan conversation history for secrets/API keys',
    handler: async (_args, ctx) => {
      if (ctx.history.length === 0) {
        return text('No conversation to scan.')
      }
      const { maskSecrets, formatScanSummary } = await import('../utils/secretScanner.js')
      const allText = JSON.stringify(ctx.history)
      const result = maskSecrets(allText)
      if (!result.found) {
        return text('✓ No secrets detected in conversation history.')
      }
      return text('⚠ ' + formatScanSummary(result))
    },
  },
  {
    name: 'debug-tool-call',
    aliases: ['dtc'],
    description:
      'Inspect recent tool calls and results from conversation. Usage: /debug-tool-call [n]',
    handler: (args, ctx) => {
      const n = parseInt(args.trim(), 10) || 5
      const toolCalls: Array<{
        index: number
        name: string
        args: string
        result: string | null
        isError: boolean
        toolCallId: string
      }> = []
      for (let i = 0; i < ctx.history.length; i++) {
        const msg = ctx.history[i]
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            toolCalls.push({
              index: i,
              name: tc.function.name,
              args: tc.function.arguments,
              result: null,
              isError: false,
              toolCallId: tc.id,
            })
          }
        }
        if (msg.role === 'tool' && msg.tool_call_id) {
          const tc = toolCalls.find((t) => t.toolCallId === msg.tool_call_id)
          if (tc) {
            tc.result = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content)
            if (typeof msg.content === 'string') {
              tc.isError =
                msg.content.toLowerCase().includes('error') ||
                msg.content.toLowerCase().includes('failed')
            }
          }
        }
      }
      if (toolCalls.length === 0) {
        return text('No tool calls in conversation history.')
      }
      const recent = toolCalls.slice(-n)
      const lines: string[] = [
        `Recent ${recent.length} tool call(s) (of ${toolCalls.length} total):`,
      ]
      lines.push('')
      for (let i = 0; i < recent.length; i++) {
        const tc = recent[i]
        const status = tc.isError ? '✗ ERROR' : '✓ OK'
        lines.push(`── #${i + 1} [msg ${tc.index}] ${tc.name} ${status} ──`)
        lines.push(`  Args: ${truncate(tc.args, 200)}`)
        if (tc.result) {
          lines.push(`  Result: ${truncate(tc.result, 300)}`)
        } else {
          lines.push('  Result: (none)')
        }
        lines.push('')
      }
      return text(lines.join('\n'))
    },
  },
  {
    name: 'onboard',
    aliases: ['overview', 'project-info'],
    description: 'Generate a comprehensive project overview (structure, deps, tests, stats)',
    handler: async (_args, ctx) => {
      const { analyzeProject, formatOverview } = await import('../core/onboarding.js')
      const overview = analyzeProject(ctx.cwd)
      return text(formatOverview(overview))
    },
  },
  {
    name: 'metrics',
    aliases: ['complexity', 'health'],
    description:
      'Analyze code metrics and health. Usage: /metrics [file <path> | project <paths...> | health <path>]',
    handler: async (args, ctx) => {
      const {
        analyzeFile,
        analyzeProjectFiles,
        formatFileMetrics,
        formatProjectMetrics,
        assessHealth,
        formatHealthAssessment,
      } = await import('../core/codeMetrics.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'help'
      if (sub === 'file') {
        const filePath = parts[1]
        if (!filePath) return text('Usage: /metrics file <path>')
        const resolved = resolve(ctx.cwd, filePath)
        const m = analyzeFile(resolved)
        if (!m) return text('File not found')
        return text(formatFileMetrics(m))
      }
      if (sub === 'health') {
        const filePath = parts[1]
        if (!filePath) return text('Usage: /metrics health <path>')
        const resolved = resolve(ctx.cwd, filePath)
        const m = analyzeFile(resolved)
        if (!m) return text('File not found')
        return text(formatHealthAssessment(assessHealth(m)))
      }
      if (sub === 'project') {
        const paths = parts.slice(1).map((p: string) => resolve(ctx.cwd, p))
        if (paths.length === 0) return text('Usage: /metrics project <file1> [file2...]')
        const metrics = analyzeProjectFiles(paths)
        return text(formatProjectMetrics(metrics))
      }
      return text(`Usage: /metrics [file <path> | health <path> | project <paths...>]`)
    },
  },
  {
    name: 'diagnostics',
    aliases: ['diag', 'lint', 'typecheck'],
    description:
      'Run code diagnostics (tsc/ESLint/Biome/Ruff). Usage: /diagnostics [checker] [file <path>] [--clear]',
    handler: async (args, ctx) => {
      const { runDiagnostics, filterDiagnostics, formatDiagnosticsResult, clearCache } =
        await import('../core/diagnostics.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const clearFlag = parts.includes('--clear') || parts.includes('--fresh')
      if (clearFlag) clearCache()
      const validCheckers = ['auto', 'tsc', 'eslint', 'biome', 'ruff']
      const checker = parts.find((p) => validCheckers.includes(p)) ?? 'auto'
      const fileIdx = parts.indexOf('file')
      const filePath = fileIdx >= 0 ? parts[fileIdx + 1] : undefined
      try {
        const result = runDiagnostics(
          ctx.cwd,
          checker as 'auto' | 'tsc' | 'eslint' | 'biome' | 'ruff',
        )
        if (filePath) {
          const filtered = filterDiagnostics(result, { filePath })
          if (filtered.length === 0) return text(`✓ No diagnostics for "${filePath}"`)
          const lines = filtered.map(
            (d) => `${d.filePath}:${d.line}:${d.column} [${d.severity}] ${d.message}`,
          )
          return text(lines.join('\n'))
        }
        return text(formatDiagnosticsResult(result))
      } catch (err) {
        return text(`Failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  },
  {
    name: 'cache',
    description: 'Prompt cache statistics. Usage: /cache [stats | reset | health]',
    handler: async (args) => {
      const cs = await import('../utils/cacheStats.js')
      const parts = args.trim().split(/\s+/).filter(Boolean)
      const sub = parts[0] ?? 'stats'
      if (sub === 'stats') {
        return text(cs.formatCacheStats(cs.getCacheStats()))
      }
      if (sub === 'reset') {
        cs.resetCacheStats()
        return text('Cache statistics reset.')
      }
      if (sub === 'health') {
        const warning = cs.checkCacheHealth()
        if (!warning) return text('Cache health: OK')
        return text(cs.formatCacheWarning(warning))
      }
      return text(cs.formatCacheStats(cs.getCacheStats()))
    },
  },
  {
    name: 'health',
    description: 'System health checks. Usage: /health',
    handler: async () => {
      const sh = await import('../utils/systemHealth.js')
      const report = sh.runSystemHealthChecks()
      return text(sh.formatSystemHealth(report))
    },
  },
]
