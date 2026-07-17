/**
 * EnterPlanMode Tool — let the LLM switch into plan mode for read-only analysis.
 *
 * Inspired by Claude Code's EnterPlanModeTool.
 *
 * Entering plan mode restricts the agent to read-only tools (Read/Glob/Grep/Web)
 * so it can analyze the codebase without making changes. Once the plan is
 * ready, the LLM calls ExitPlanMode to present it for user approval.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult } from '../core/types.js'

export class EnterPlanModeTool implements Tool {
  name = 'EnterPlanMode'
  metadata = { readOnly: true, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'EnterPlanMode',
      description: `Enter plan mode to perform read-only analysis. While in plan mode, only read-only tools (Read, Glob, Grep, Web) are available — write/edit tools are disabled.

## When to Use
- The task is non-trivial and you need to explore the codebase before changing anything
- You want to gather requirements, map dependencies, or draft an approach
- The user asked you to "plan" or "think through" before implementing

## When NOT to Use
- You already know what to do and can act immediately
- The task is a single small change
- You're already in plan mode (idempotent — entering again is a no-op)

After analysis, call ExitPlanMode with your plan to request user approval.`,
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  }

  isConcurrencySafe(): boolean {
    return true
  }

  execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    try {
      ctx.enterPlanMode?.()
      return Promise.resolve({
        content: 'Entered plan mode. Only read-only tools (Read/Glob/Grep/Web) are available. Analyze, then call ExitPlanMode with your plan for approval.',
        isError: false,
      })
    } catch (err) {
      return Promise.resolve({
        content: `Failed to enter plan mode: ${(err as Error).message}`,
        isError: true,
      })
    }
  }
}
