/**
 * GrepTool — search file contents with regex
 * Reference: src/tools/GrepTool/
 * Uses ripgrep (rg) if available, falls back to Node.js regex scan
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { relative } from 'path'
import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { GREP_DESCRIPTION } from '../prompts/tools.js'
import { resolveWorkspacePath } from '../core/workspacePath.js'

const execFileAsync = promisify(execFile)

export interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  output_mode?: 'files_with_matches' | 'content' | 'count'
  context?: number
  case_insensitive?: boolean
  include?: string
}

export class GrepTool implements Tool {
  name = 'Grep'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Grep',
      description: GREP_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Regex pattern to search for',
          },
          path: {
            type: 'string',
            description: 'File or directory to search (defaults to cwd)',
          },
          glob: {
            type: 'string',
            description: 'File pattern filter (e.g. "*.ts", "**/*.tsx")',
          },
          include: {
            type: 'string',
            description: 'File extension filter (e.g. "ts", "js", "py"). Shorthand for glob: "*.ts"',
          },
          output_mode: {
            type: 'string',
            enum: ['files_with_matches', 'content', 'count'],
            description: 'Output mode (default: files_with_matches)',
          },
          context: {
            type: 'number',
            description: 'Lines of context around matches (for content mode)',
          },
          case_insensitive: {
            type: 'boolean',
            description: 'Case-insensitive search',
          },
        },
        required: ['pattern'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const {
      pattern,
      path: searchPath,
      glob: globPattern,
      include: includePattern,
      output_mode = 'files_with_matches',
      context: contextLines,
      case_insensitive,
    } = input as unknown as GrepInput

    // include shorthand: "ts" → glob "*.ts"
    const effectiveGlob = globPattern ?? (includePattern ? `*.${includePattern}` : undefined)

    if (!pattern || typeof pattern !== 'string') {
      return { content: 'Error: pattern is required', isError: true }
    }

    let searchDir: string
    try {
      context.signal?.throwIfAborted()
      searchDir = resolveWorkspacePath(context, searchPath ?? '.')
    } catch (error) {
      return { content: `Grep error: ${(error as Error).message}`, isError: true }
    }

    // Build rg command (preferred — faster, respects .gitignore)
    const args: string[] = ['--no-config']

    if (case_insensitive) args.push('-i')

    switch (output_mode) {
      case 'files_with_matches':
        args.push('-l')
        break
      case 'count':
        args.push('-c')
        break
      case 'content':
        args.push('-n') // line numbers
        if (typeof contextLines === 'number' && contextLines > 0) {
          args.push(`-C${contextLines}`)
        }
        break
    }

    if (effectiveGlob) {
      // Use the long `--glob=<value>` form so a glob starting with `-`
      // is unambiguously the FLAG's argument, never another flag.
      // (ripgrep, like most GNU-style CLIs, accepts a separate
      // positional after a long flag; `--glob -file.ts` would be
      // parsed as "ignore `--glob`, then take `-file.ts` as a new
      // flag — which is exactly the misinterpretation we're guarding
      // against. The `=` form pins the value to its flag.)
      args.push(`--glob=${effectiveGlob}`)
    }

    // Truncate long lines to prevent context pollution from minified/base64 content
    args.push('--max-columns', '500')

    // Use -e flag for patterns starting with '-' (prevents rg from interpreting as flag)
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }
    args.push(searchDir)

    try {
      // Use execFile to avoid shell quoting issues on Windows
      // Try rg first, fall back to grep via exec if rg not found
      let stdout: string
      try {
        const result = await execFileAsync('rg', args, {
          cwd: context.cwd,
          maxBuffer: 10 * 1024 * 1024,
          timeout: 30_000,
          signal: context.signal,
        })
        stdout = result.stdout
      } catch (err: unknown) {
        const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string }
        // rg exits with code 1 when no matches — not an error
        if (e.code === 1 && !e.stderr) {
          return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
        }
        if (e.code !== 'ENOENT') {
          return { content: `Grep error: ${e.stderr || e.message || String(err)}`, isError: true }
        }
        const grepFlags = ['-r', case_insensitive ? '-i' : '', output_mode === 'files_with_matches' ? '-l' : output_mode === 'count' ? '-c' : '-n'].filter(Boolean)
        if (effectiveGlob) grepFlags.push('--include', effectiveGlob)
        if (output_mode === 'content' && typeof contextLines === 'number' && contextLines > 0) grepFlags.push('-C', String(contextLines))
        grepFlags.push('-E', '-e', pattern, '--', searchDir)
        try {
          const fallback = await execFileAsync('grep', grepFlags, {
            cwd: context.cwd,
            maxBuffer: 10 * 1024 * 1024,
            timeout: 30_000,
            signal: context.signal,
          })
          stdout = fallback.stdout
        } catch (grepErr) {
          const ge = grepErr as { code?: string | number; stderr?: string; message?: string }
          if (ge.code === 'ENOENT') {
            return { content: `Error: neither ripgrep (rg) nor grep is available on this system. Install ripgrep for best results.`, isError: true }
          }
          if (ge.code !== 1 || ge.stderr) return { content: `Grep error: ${ge.stderr || ge.message || String(grepErr)}`, isError: true }
          return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
        }
      }

      const result = stdout.trim()
      if (!result) {
        return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
      }

      // Cap output to avoid flooding context
      const lines = result.split('\n')
      // Convert absolute paths to relative — saves tokens in large codebases
      // (e.g. /home/user/projects/myapp/src/foo.ts → src/foo.ts)
      const relLines = lines.map((line) => {
        try {
          return line.replace(/^([^\s:]+):/, (match, p1: string) => {
            if (p1.startsWith('/')) {
              const rel = relative(context.cwd, p1)
              return rel.startsWith('..') ? match : `${rel}:`
            }
            return match
          })
        } catch {
          return line
        }
      })

      if (relLines.length > 500) {
        const truncated = relLines.slice(0, 500).join('\n')
        return {
          content: `${truncated}\n\n[... truncated: ${relLines.length - 500} more lines. Narrow your pattern or use output_mode="count" to reduce results.]`,
          isError: false,
        }
      }

      return { content: relLines.join('\n'), isError: false }
    } catch (err: unknown) {
      // rg exits with code 1 when no matches — that's not an error
      const error = err as { code?: number; stdout?: string; stderr?: string }
      if (error.code === 1 && !error.stderr) {
        return { content: `No matches found for pattern: ${pattern}. Try case_insensitive:true, broaden the regex, remove the glob filter, or use Glob to confirm the file exists.`, isError: false }
      }
      const msg = error.stderr ?? (err as Error).message ?? 'Unknown grep error'
      return { content: `Grep error: ${msg}`, isError: true }
    }
  }
}
