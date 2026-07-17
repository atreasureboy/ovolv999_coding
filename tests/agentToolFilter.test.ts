/**
 * agentToolFilter — global sub-agent tool denylist + per-agent
 * allow/deny filtering.
 *
 * The functions under test are pure (no I/O, no module lookups), so
 * the test cases pin the exact membership and precedence contract
 * without spinning up the engine. Defence-in-depth tests for the
 * integration live in tests/engine.test.ts.
 */

import { describe, it, expect } from 'vitest'
import {
  filterToolsForSubAgent,
  SUB_AGENT_DISALLOWED_TOOLS,
} from '../src/core/agentToolFilter.js'

describe('filterToolsForSubAgent', () => {
  // A representative slice of the engine's tool inventory. Includes the
  // four globally-disallowed names so each test case can verify they
  // were dropped, and an MCP tool so the mcp__ pass-through can be
  // verified.
  const allTools: string[] = [
    'Bash',
    'Read',
    'Write',
    'Edit',
    'Agent',
    'Grep',
    'EnterPlanMode',
    'ExitPlanMode',
    'VerifyPlanExecution',
    'mcp__fs__read',
    'mcp__fs__write',
  ]

  it('removes globally disallowed tools for sub-agents', () => {
    const result = filterToolsForSubAgent(allTools, undefined, undefined)
    expect(result).not.toContain('Agent')
    expect(result).not.toContain('EnterPlanMode')
    expect(result).not.toContain('ExitPlanMode')
    expect(result).not.toContain('VerifyPlanExecution')
    expect(result).toContain('Bash')
    expect(result).toContain('Read')
    // MCP tools pass through unconditionally when no allowlist is set.
    expect(result).toContain('mcp__fs__read')
  })

  it('applies allowlist on top of global disallow', () => {
    // Even though 'Agent' is in the allowlist, the global disallow
    // (applied AFTER allowlist) still removes it. This is the
    // recursion-guard contract: a preset that lists Agent in its tools
    // can never give Agent to a sub-agent.
    const result = filterToolsForSubAgent(allTools, ['Read', 'Grep', 'Agent'], undefined)
    expect(result).toContain('Read')
    expect(result).toContain('Grep')
    expect(result).not.toContain('Agent')
    expect(result).not.toContain('Bash')
  })

  it('always passes through mcp__ tools', () => {
    // The allowlist is `['Read']` — MCP tools don't match exactly but
    // are explicitly preserved by the `name.startsWith('mcp__')`
    // branch. This matters because MCP servers are dynamically added
    // at runtime and shouldn't be silently stripped by a strict
    // allowlist.
    const result = filterToolsForSubAgent(allTools, ['Read'], undefined)
    expect(result).toContain('Read')
    expect(result).toContain('mcp__fs__read')
    expect(result).toContain('mcp__fs__write')
  })

  it('applies per-agent denylist', () => {
    const result = filterToolsForSubAgent(allTools, undefined, ['Bash', 'Write'])
    expect(result).not.toContain('Bash')
    expect(result).not.toContain('Write')
    expect(result).toContain('Read')
    expect(result).toContain('Edit')
  })

  it('combines denylist + allowlist correctly', () => {
    // Allowlist: read/write/edit are allowed
    // Denylist: 'Write' is also denied → final result has Read + Edit
    // only.
    const result = filterToolsForSubAgent(
      allTools,
      ['Read', 'Write', 'Edit'],
      ['Write'],
    )
    expect(result).toContain('Read')
    expect(result).toContain('Edit')
    expect(result).not.toContain('Write')
  })

  it('returns input unchanged when no lists are provided', () => {
    // Guard against accidental copy: when neither list is set, the
    // result is exactly the input MINUS the global denylist. The
    // global set is unconditional.
    const result = filterToolsForSubAgent(allTools, undefined, undefined)
    expect(result).not.toContain('Agent')
    // The non-disallowed tools pass through.
    expect(result).toContain('Bash')
    expect(result).toContain('Read')
    expect(result).toContain('Write')
    expect(result).toContain('Edit')
    expect(result).toContain('Grep')
    expect(result).toContain('mcp__fs__read')
  })

  it('returns empty array for empty input', () => {
    expect(filterToolsForSubAgent([], undefined, undefined)).toEqual([])
    expect(filterToolsForSubAgent([], ['Read'], ['Bash'])).toEqual([])
  })

  it('denylist entry absent from input is a no-op', () => {
    // A denylist entry that doesn't match anything in the input
    // shouldn't add or remove anything else.
    const result = filterToolsForSubAgent(['Read', 'Bash'], undefined, ['Nonexistent'])
    expect(result).toContain('Read')
    expect(result).toContain('Bash')
  })

  it('preserves input order for surviving tools', () => {
    // Filter must be a stable projection — the relative order of the
    // surviving tools should match the input. Spot-check by indices
    // (rather than full equality) so this contract is observable.
    // We assert relative order among tools that survive the global
    // disallow; the disallowed ones (Agent etc.) correctly drop out
    // so we cannot compare indices for them.
    const result = filterToolsForSubAgent(allTools, undefined, undefined)
    expect(result.indexOf('Bash')).toBeLessThan(result.indexOf('Read'))
    expect(result.indexOf('Read')).toBeLessThan(result.indexOf('Write'))
    expect(result.indexOf('Write')).toBeLessThan(result.indexOf('Edit'))
    expect(result.indexOf('Edit')).toBeLessThan(result.indexOf('Grep'))
    // Disallowed tools must NOT appear in the output (negative
    // corollary of the order check above).
    expect(result).not.toContain('Agent')
    expect(result).not.toContain('EnterPlanMode')
    expect(result).not.toContain('ExitPlanMode')
    expect(result).not.toContain('VerifyPlanExecution')
  })
})

describe('SUB_AGENT_DISALLOWED_TOOLS', () => {
  it('includes Agent, EnterPlanMode, ExitPlanMode, VerifyPlanExecution', () => {
    // The contract is hardcoded into multiple places (engine,
    // getToolDefinitions, executeToolCall) and into the per-test
    // expectations above. Pinning the membership here means a future
    // refactor that drops an entry will trip these tests before it
    // can ship.
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Agent')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('EnterPlanMode')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('ExitPlanMode')).toBe(true)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('VerifyPlanExecution')).toBe(true)
  })

  it('does not include ordinary tools', () => {
    // Negative test: the only entries are the four listed above. Any
    // future addition is a deliberate behavior change that should
    // update tests AND the docs comment together.
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Bash')).toBe(false)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Read')).toBe(false)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Write')).toBe(false)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Edit')).toBe(false)
    expect(SUB_AGENT_DISALLOWED_TOOLS.has('Grep')).toBe(false)
  })
})