import { describe, it, expect } from 'vitest'
import { dispatchSlashCommand, type SlashCommandContext, getCommand } from '../index.js'
import '../builtin.js' // register all built-in slash commands
import type { OpenAIMessage } from '../../core/types.js'
import type { ExecutionEngine } from '../../core/engine.js'
import type { Renderer } from '../../ui/renderer.js'

// We test the slash-command layer by wiring in stubs for the Engine /
// Renderer. These commands don't reach across to LLM calls, so we never
// hit those surfaces — but the framework requires the types to be present.

function makeRenderer(): Renderer {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    humanPrompt: () => {},
    writePrompt: () => {},
    newline: () => {},
  } as unknown as Renderer
}

function makeEngine(): ExecutionEngine {
  return {} as ExecutionEngine
}

function makeCtx(extra: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const history: OpenAIMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'Hello, how are you?' },
    { role: 'assistant', content: 'I am fine, thank you!' },
    { role: 'user', content: 'What can you do?' },
  ]
  return {
    engine: makeEngine(),
    renderer: makeRenderer(),
    history,
    cwd: '/tmp',
    sessionDir: undefined,
    setHistory: (msgs) => {
      history.length = 0
      history.push(...msgs)
    },
    runPrompt: () => {},
    ...extra,
  }
}

describe('dispatchSlashCommand', () => {
  it('returns null for non-slash input', async () => {
    const result = await dispatchSlashCommand('hello', makeCtx())
    expect(result).toBeNull()
  })

  it('returns unknown command text-equivalent via fallback when not registered', async () => {
    const result = await dispatchSlashCommand('/never_registered_xyz', makeCtx())
    // Without resolveSkillPrompt + without a registered command, falls through to null
    expect(result).toBeNull()
  })
})

describe('/history', () => {
  it('is registered and shows default 10 most recent + count', async () => {
    const history = getCommand('history')
    expect(history).toBeDefined()
    const ctx = makeCtx()
    const result = await history!.handler('', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('Showing all 4 messages')
    // Role labels rendered with padEnd so "[You]" / "[AI]" match against
    // the substrings "[You " / "[AI " (trailing space).
    expect(value).toMatch(/\[You /)
    expect(value).toMatch(/\[AI /)
    expect(value).toContain('Session: 4 messages')
  })

  it('supports /history N for last N messages', async () => {
    const history = getCommand('history')
    const ctx = makeCtx()
    const result = await history!.handler('2', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    // Should show only last 2 — assistant then user "What can you do?"
    expect(value).toContain('Showing last 2 of 4 messages')
    // Must NOT include the first user message
    expect(value).not.toContain('Hello, how are you')
  })

  it('falls back to default N on bad input', async () => {
    const history = getCommand('history')
    const ctx = makeCtx()
    const result = await history!.handler('notanumber', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('Showing all 4 messages')
  })

  it('handles empty history gracefully', async () => {
    const history = getCommand('history')
    const ctx = makeCtx()
    ctx.history.length = 0
    const result = await history!.handler('', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('No messages')
  })
})

describe('/resume', () => {
  it('is registered', () => {
    expect(getCommand('resume')).toBeDefined()
  })

  it('lists sessions when no args provided', async () => {
    const resume = getCommand('resume')
    const ctx = makeCtx({ getSessionsText: () => 'Found 3 session(s):\n  session_a 10 msgs' })
    const result = await resume!.handler('', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('Found 3 session(s)')
  })

  it('loads a session when given a name + valid loadSession callback', async () => {
    const resume = getCommand('resume')
    const loaded: OpenAIMessage[] = [
      { role: 'user', content: 'Previous question' },
      { role: 'assistant', content: 'Previous answer' },
    ]
    const ctx = makeCtx({
      loadSession: (name) => (name === 'session_x' ? loaded : null),
    })
    const result = await resume!.handler('session_x', ctx)
    expect(result.type).toBe('text')
    expect((result as { type: 'text'; value: string }).value).toContain('2 messages loaded')
    expect(ctx.history).toEqual(loaded)
  })

  it('reports not-found when loadSession returns null', async () => {
    const resume = getCommand('resume')
    const ctx = makeCtx({ loadSession: () => null })
    const result = await resume!.handler('badname', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('Session not found')
  })

  it('reports no loadSession when callback is missing', async () => {
    const resume = getCommand('resume')
    const ctx = makeCtx()
    const result = await resume!.handler('anyname', ctx)
    expect(result.type).toBe('text')
    const value = (result as { type: 'text'; value: string }).value
    expect(value).toContain('In-session resume is not available')
  })
})

describe('edge cases', () => {
  it('registry has expected builtins available', () => {
    expect(getCommand('help')).toBeDefined()
    expect(getCommand('history')).toBeDefined()
    expect(getCommand('resume')).toBeDefined()
    expect(getCommand('clear')).toBeDefined()
    expect(getCommand('exit')).toBeDefined()
  })
})
