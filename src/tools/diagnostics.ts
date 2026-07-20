/**
 * Diagnostics Tool
 *
 * Exposes the diagnostics service to the LLM. Lets the model query
 * type errors, lint errors, and other code diagnostics on demand.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { runDiagnostics, filterDiagnostics, formatDiagnosticsResult, clearCache } from '../core/diagnostics.js'

export class DiagnosticsTool implements Tool {
  name = 'Diagnostics'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Diagnostics',
      description: `Run type checking and linting on the codebase to get diagnostics (errors, warnings). Supports TypeScript (tsc), ESLint, Biome, and Ruff (Python).

## When to Use
- After making code changes to check for type errors
- Before running tests to catch issues early
- When debugging compilation errors
- To verify a fix doesn't introduce new errors

## Output
Returns a summary of errors/warnings grouped by file, with line/column positions and messages.

Use clear_cache=true to force a fresh check (otherwise results are cached for 30s).`,
      parameters: {
        type: 'object',
        properties: {
          checker: {
            type: 'string',
            enum: ['auto', 'tsc', 'eslint', 'biome', 'ruff'],
            description: 'Which checker to use. "auto" detects based on project config (default).',
          },
          file_path: {
            type: 'string',
            description: 'Filter to only show diagnostics for files matching this path substring',
          },
          severity: {
            type: 'string',
            enum: ['all', 'error', 'warning', 'info'],
            description: 'Filter by severity (default: all)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of diagnostics to return (default: 50)',
          },
          clear_cache: {
            type: 'boolean',
            description: 'Clear cached results and run fresh check (default: false)',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const checker = (input.checker as string) ?? 'auto'
    const filePath = input.file_path as string | undefined
    const severity = (input.severity as string) ?? 'all'
    const limit = (input.limit as number) ?? 50
    const clearCacheFlag = input.clear_cache as boolean | undefined

    if (clearCacheFlag) {
      clearCache()
    }

    try {
      const result = runDiagnostics(ctx.cwd, checker as 'auto' | 'tsc' | 'eslint' | 'biome' | 'ruff')

      if (filePath || severity !== 'all') {
        const filtered = filterDiagnostics(result, {
          filePath,
          severity: severity as 'all' | 'error' | 'warning' | 'info',
          limit,
        })

        if (filtered.length === 0) {
          return Promise.resolve({
            content: `✓ No ${severity === 'all' ? '' : severity + ' '}diagnostics${filePath ? ` matching "${filePath}"` : ''} (${result.checker}, ${result.duration}ms)`,
            isError: false,
          })
        }

        const lines = filtered.map(d => {
          const tag = d.severity === 'error' ? 'E' : d.severity === 'warning' ? 'W' : 'I'
          const code = d.code ? ` [${d.code}]` : ''
          return `${d.filePath}:${d.line}:${d.column} ${tag}${code} ${d.message}`
        })

        return Promise.resolve({
          content: `Found ${filtered.length} diagnostic(s) (${result.checker}, ${result.duration}ms):\n${lines.join('\n')}`,
          isError: false,
        })
      }

      return Promise.resolve({
        content: formatDiagnosticsResult(result),
        isError: false,
      })
    } catch (err) {
      return Promise.resolve({
        content: `Failed to run diagnostics: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      })
    }
  }
}
