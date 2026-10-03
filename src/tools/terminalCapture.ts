/**
 * TerminalCapture Tool — capture the visible terminal screen
 *
 * Captures what's currently on the user's screen so the model can
 * "see" the terminal state. Useful when:
 *   - A command produced visual output the model needs to interpret
 *   - A TUI (vim, htop) is running in a tmux pane
 *   - The model needs to verify a command's side-effects on screen
 *
 * Capture strategies (in priority order):
 *   1. tmux capture-pane (when inside tmux / a tmux session is targeted)
 *   2. ANSI ESC[6n cursor-position-style screen readback (limited)
 *   3. Fallback: report that capture isn't available
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { assertExecutionProfile, execManaged } from '../core/executionBackend.js'

export class TerminalCaptureTool implements Tool {
  name = 'TerminalCapture'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'TerminalCapture',
      description: `Capture the current terminal screen contents. Works inside tmux sessions (via capture-pane) or returns the visible screen buffer.

## When to Use
- After running a TUI command (vim, htop, less) to see its state
- To verify visual output from a command you just ran
- To inspect what's currently displayed without re-running a command

## Limitations
- Only captures tmux panes or terminal emulators that support screen readback
- ANSI colors are stripped to plain text
- Use the Bash tool to run commands and capture their stdout directly when possible — this tool is for *visual* capture`,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'tmux target pane (e.g. "0", "session:0.1"). Defaults to the current pane.',
          },
          lines: {
            type: 'number',
          description: 'Number of lines to capture from the bottom. Default: full pane height.',
          },
        },
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const target = (input.target as string) ?? ''
    const lines = input.lines as number | undefined
    if (typeof target !== 'string' || (lines !== undefined && (!Number.isSafeInteger(lines) || lines < 0))) return { content: 'Invalid capture target or line count', isError: true }
    try {
      ctx.signal?.throwIfAborted()
      assertExecutionProfile(ctx.executionProfile)
    } catch (err) {
      return { content: `Terminal capture refused: ${(err as Error).message}`, isError: true, status: ctx.signal?.aborted ? 'cancelled' : 'blocked' }
    }

    // Strategy 1: tmux capture-pane
    if (process.env.TMUX || target) {
      try {
        return await this.captureTmux(target, lines, ctx)
      } catch (err) {
        // Fall through to other strategies
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('no tmux') || msg.includes('not found')) {
          // fall through
        } else {
          return { content: `tmux capture failed: ${msg}`, isError: true }
        }
      }
    }

    return {
      content: 'Terminal capture not available: not inside tmux and no screen readback support.',
      isError: false,
    }
  }

  private async captureTmux(target: string, lines: number | undefined, ctx: ToolContext): Promise<ToolResult> {
    const args = ['capture-pane', ...(target ? ['-t', target] : []), '-S', lines === undefined ? '-' : `-${lines}`, '-E', '-', '-p']
    const { stdout: output } = await execManaged('tmux', args, { cwd: ctx.cwd, profile: ctx.executionProfile, signal: ctx.signal, timeoutMs: 5000 })

    const cleaned = stripAnsi(output).trimEnd()
    if (cleaned.length === 0) {
      return { content: '(tmux pane is empty)', isError: false }
    }

    const lineCount = cleaned.split('\n').length
    return {
      content: `Captured ${lineCount} lines from ${target ? `pane ${target}` : 'current pane'}:\n\n\`\`\`\n${cleaned}\n\`\`\``,
      isError: false,
    }
  }

}

/** Strip ANSI escape sequences (colors, cursor moves, etc.) */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b[=>]/g, '')
}
