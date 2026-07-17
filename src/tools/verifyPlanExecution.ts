/**
 * VerifyPlanExecution Tool — run project build/lint/test to confirm implementation.
 *
 * Inspired by Claude Code's VerifyPlanExecutionTool.
 *
 * Detects appropriate verification commands from package.json scripts or
 * language-specific fallbacks, executes them, and returns pass/fail output.
 * Non-readOnly: only meaningful after code changes — filtered out in plan mode.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'
import { runVerification } from './agent.js'

export class VerifyPlanExecutionTool implements Tool {
  name = 'VerifyPlanExecution'
  metadata = { readOnly: false, concurrencySafe: false, longRunning: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'VerifyPlanExecution',
      description: `Run project build/lint/test verification for the current implementation. Detects commands from package.json scripts (typecheck/lint/test/build) or falls back per language. Use this AFTER making changes to self-check.

## When to Use
- You just edited code and want to confirm it still compiles/tests pass
- You're wrapping up a task and want a final sanity check

## When NOT to Use
- In plan mode (this tool runs project commands — only available in execution mode)
- For trivial edits where verification overhead isn't worth it

## Output
Returns pass/fail per command plus a failure summary (stdout/stderr, truncated). isError is true when any command fails.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }

  isConcurrencySafe(): boolean {
    return false
  }

  execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      const result = runVerification(ctx.cwd)
      if (!result) {
        return Promise.resolve({
          content: 'No verification commands detected for this project.',
          isError: false,
        })
      }
      const icon = result.passed ? '✓' : '✗'
      return Promise.resolve({
        content: `${icon} ${result.passed ? 'All checks passed' : 'Verification failed'}\n\n${result.output}`,
        isError: !result.passed,
      })
    } catch (err) {
      return Promise.resolve({
        content: `Verification error: ${(err as Error).message}`,
        isError: true,
      })
    }
  }
}
