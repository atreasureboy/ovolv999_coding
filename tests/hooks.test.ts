import { describe, expect, it, vi } from 'vitest'
import { HookRunner, NoopHookRunner, type HookCommandRunner, type HookExecOptions, type HookFailureSink } from '../src/config/hooks.js'
import type { HooksConfig, HookEntry } from '../src/config/settings.js'
import type { HookResult } from '../src/core/types.js'

function entry(command: string, matcher?: string): HookEntry {
  return matcher === undefined ? { command } : { command, matcher }
}

function hooks(overrides: Partial<HooksConfig> = {}): HooksConfig {
  return { ...overrides }
}

type RunnerResult = ReturnType<HookCommandRunner>

function fakeRunner(scenario: (options: HookExecOptions) => RunnerResult): {
  calls: HookExecOptions[]
  runner: HookCommandRunner
} {
  const calls: HookExecOptions[] = []
  return {
    calls,
    runner: (options) => {
      calls.push(options)
      return scenario(options)
    },
  }
}

describe('HookRunner — matcher logic', () => {
  it('matches an entry with no matcher against any tool', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo hi')] }), { runner })

    const results = r.runPreToolCall('Anything', { foo: 1 })
    expect(results).toHaveLength(1)
    expect(results[0].ok).toBe(true)
    expect(calls[0].command).toBe('echo hi')
  })

  it('respects exact matcher names', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('echo bash', 'Bash'), entry('echo read', 'Read')] }),
      { runner },
    )

    r.runPreToolCall('Bash', {})
    expect(calls.map((c) => c.command)).toEqual(['echo bash'])
  })

  it('supports comma-separated matcher lists', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('echo lint', 'Write,Edit,NotebookEdit')] }),
      { runner },
    )

    r.runPreToolCall('Write', {})
    r.runPreToolCall('Edit', {})
    r.runPreToolCall('Read', {})
    expect(calls.map((c) => c.command)).toEqual(['echo lint', 'echo lint'])
  })

  it('honours trailing-* wildcards', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('echo all-bash', 'Bash*')] }),
      { runner },
    )

    r.runPreToolCall('Bash', {})
    r.runPreToolCall('BashRun', {})
    r.runPreToolCall('Read', {})
    expect(calls.map((c) => c.command)).toEqual(['echo all-bash', 'echo all-bash'])
  })

  it('does not invoke non-matching entries', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('nope', 'Read')] }),
      { runner },
    )

    expect(r.runPreToolCall('Bash', {})).toEqual([])
    expect(calls).toHaveLength(0)
  })
})

describe('HookRunner — env propagation', () => {
  it('passes OVOGO_* env vars to every hook entry', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo')] }), { runner })

    r.runPreToolCall('Bash', { command: 'rm -rf /tmp/x' })

    expect(calls[0].env.OVOGO_TOOL_NAME).toBe('Bash')
    expect(calls[0].env.OVOGO_TOOL_INPUT).toContain('rm -rf /tmp/x')
  })

  it('propagates result + error flag on PostToolCall', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ PostToolCall: [entry('log')] }), { runner })

    r.runPostToolCall('Write', 'output text', true)
    expect(calls[0].env.OVOGO_TOOL_NAME).toBe('Write')
    expect(calls[0].env.OVOGO_TOOL_RESULT).toBe('output text')
    expect(calls[0].env.OVOGO_TOOL_IS_ERROR).toBe('true')
  })

  it('truncates oversized payload env vars to 4096 chars', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ UserPromptSubmit: [entry('echo')] }), { runner })

    r.runUserPromptSubmit('x'.repeat(10_000))
    expect(calls[0].env.OVOGO_PROMPT).toHaveLength(4096)
  })

  it('runs every entry in the configured hook list', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ UserPromptSubmit: [entry('a'), entry('b'), entry('c')] }),
      { runner },
    )

    r.runUserPromptSubmit('hello')
    expect(calls.map((c) => c.command)).toEqual(['a', 'b', 'c'])
  })
})

describe('HookRunner — failure modes are surfaced, not thrown', () => {
  it('returns ok=true with status 0 on success', () => {
    const { runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 5 }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo')] }), { runner })

    const [result] = r.runPreToolCall('Bash', {})
    expect(result.ok).toBe(true)
    expect(result.status).toBe(0)
    expect(result.signal).toBeNull()
  })

  it('surfaces non-zero exit codes without throwing', () => {
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 2,
      signal: null,
      durationMs: 3,
      error: 'Command failed',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('false')] }), { runner })

    expect(() => r.runPreToolCall('Bash', {})).not.toThrow()
    const [result] = r.runPreToolCall('Bash', {})
    expect(result.ok).toBe(false)
    expect(result.status).toBe(2)
    expect(result.errorCode).toBe('non_zero')
    expect(result.error).toBe('Command failed')
  })

  it('classifies ENOENT as not_found', () => {
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: null,
      signal: null,
      durationMs: 1,
      error: 'spawn missing-binary ENOENT',
      errorCode: 'not_found',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('missing-binary')] }), { runner })

    const [result] = r.runPreToolCall('Bash', {})
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_found')
  })

  it('classifies timeout (SIGTERM/ETIMEDOUT) as timeout', () => {
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: null,
      signal: 'SIGTERM',
      durationMs: 10_000,
      error: 'killed',
      errorCode: 'timeout',
    }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('sleep 999')] }),
      { runner, timeoutMs: 5_000 },
    )

    const [result] = r.runPreToolCall('Bash', {})
    expect(result.errorCode).toBe('timeout')
    expect(result.signal).toBe('SIGTERM')
  })

  it('invokes the legacy onFailure callback once per failing entry, never on success', () => {
    const failures: HookResult[] = []
    const { runner } = fakeRunner((options) => options.command === 'bad'
      ? { ok: false, status: 1, signal: null, durationMs: 0, error: 'fail', errorCode: 'non_zero' }
      : { ok: true, status: 0, signal: null, durationMs: 0 },
    )
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('good'), entry('bad')] }),
      { runner, onFailure: (r) => failures.push(r) },
    )

    r.runPreToolCall('Bash', {})
    expect(failures).toHaveLength(1)
    expect(failures[0].command).toBe('bad')
    expect(failures[0].errorCode).toBe('non_zero')
  })

  it('swallows onFailure sink exceptions to keep the agent loop alive', () => {
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: 'x',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('bad')] }),
      { runner, onFailure: () => { throw new Error('sink exploded') } },
    )

    expect(() => r.runPreToolCall('Bash', {})).not.toThrow()
  })
})

describe('HookRunner — sensitive env redaction', () => {
  it('scrubs credential values from surfaced error messages', () => {
    const SECRET = 'sk-test-abcdefghij1234567890'
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: null,
      signal: null,
      durationMs: 0,
      // The runner's error message includes the leaked env value (as a real
      // execSync message would). The runner itself doesn't redact — HookRunner
      // strips values from the env it passed before returning.
      error: 'failed with token sk-test-abcdefghij1234567890 in argv',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo')] }), { runner })

    // Stuff a sensitive value through a hook env var that ends up in error text.
    // We simulate this by patching process.env for the runner call.
    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = SECRET
    try {
      const [result] = r.runPreToolCall('Bash', {})
      expect(result.error).toBeDefined()
      expect(result.error).not.toContain(SECRET)
      expect(result.error).toContain('[REDACTED]')
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }
  })

  it('redacts only sensitive keys (non-sensitive env passes through untouched)', () => {
    const plain = 'plain-value-not-secret-1234'
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: `failed: ${plain}`,
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo')] }), { runner })

    const original = process.env.OVOGO_PLAIN
    process.env.OVOGO_PLAIN = plain
    try {
      const [result] = r.runPreToolCall('Bash', {})
      expect(result.error).toContain(plain)
    } finally {
      if (original === undefined) delete process.env.OVOGO_PLAIN
      else process.env.OVOGO_PLAIN = original
    }
  })

  it('redacts values supplied via the per-hook env (OVOGO_API_KEY style)', () => {
    const SECRET = 'sk-extra-sensitive-token-zzzzzzz'
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: `failure echoing ${SECRET}`,
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(
      // We can't directly inject OVOGO_API_KEY via the public surface, but
      // the runner sees the env it receives. Patch process.env so the default
      // execSync would also see it; here we verify the redaction logic by
      // putting the value in the env we pass to runner.
      hooks({ PreToolCall: [entry('echo')] }),
      { runner },
    )

    // Set the env var so defaultRunner picks it up via process.env spread.
    const original = process.env.ANTHROPIC_AUTH_TOKEN
    process.env.ANTHROPIC_AUTH_TOKEN = SECRET
    try {
      const [result] = r.runPreToolCall('Bash', {})
      expect(result.error).not.toContain(SECRET)
    } finally {
      if (original === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN
      else process.env.ANTHROPIC_AUTH_TOKEN = original
    }
  })

  it('skips very short env values to avoid over-redacting random substrings', () => {
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: 'failure abc',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('echo')] }), { runner })

    const original = process.env.AWS_SECRET_ACCESS_KEY
    // value < 8 chars → should NOT be redacted (too short to safely match)
    process.env.AWS_SECRET_ACCESS_KEY = 'abc'
    try {
      const [result] = r.runPreToolCall('Bash', {})
      expect(result.error).toContain('abc')
    } finally {
      if (original === undefined) delete process.env.AWS_SECRET_ACCESS_KEY
      else process.env.AWS_SECRET_ACCESS_KEY = original
    }
  })
})

describe('HookRunner — hook lifecycle coverage', () => {
  it('runs every OnError entry with the right env contract', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ OnError: [entry('notify')] }), { runner })

    r.runOnError(new Error('boom'), { turnNumber: 3, lastToolName: 'Bash' })
    expect(calls[0].env.OVOGO_ERROR_MESSAGE).toBe('boom')
    expect(calls[0].env.OVOGO_TURN_NUMBER).toBe('3')
    expect(calls[0].env.OVOGO_LAST_TOOL).toBe('Bash')
  })

  it('runs every OnComplete entry with the run reason', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ OnComplete: [entry('archive')] }), { runner })

    r.runOnComplete({ reason: 'stop_sequence', stopped: true, output: 'final answer' })
    expect(calls[0].env.OVOGO_RUN_REASON).toBe('stop_sequence')
    expect(calls[0].env.OVOGO_RUN_OUTPUT).toBe('final answer')
  })

  it('runs every OnContextOverflow entry with before/after tokens', () => {
    const { calls, runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ OnContextOverflow: [entry('compact')] }), { runner })

    r.runOnContextOverflow(1200, 800)
    expect(calls[0].env.OVOGO_TOKENS_BEFORE).toBe('1200')
    expect(calls[0].env.OVOGO_TOKENS_AFTER).toBe('800')
  })
})

describe('HookRunner — result shape', () => {
  it('every returned HookResult carries the hook name and command', () => {
    const { runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('echo a'), entry('echo b')] }),
      { runner },
    )

    const results = r.runPreToolCall('Bash', {})
    expect(results.map((r) => r.hook)).toEqual(['PreToolCall', 'PreToolCall'])
    expect(results.map((r) => r.command)).toEqual(['echo a', 'echo b'])
  })

  it('returns an empty array when no hooks are configured for that stage', () => {
    const { runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ PostToolCall: [entry('echo')] }), { runner })

    expect(r.runPreToolCall('Bash', {})).toEqual([])
    expect(r.runUserPromptSubmit('hi')).toEqual([])
  })
})

describe('NoopHookRunner', () => {
  it('returns an empty array for every method', () => {
    const r = new NoopHookRunner()
    expect(r.runPreToolCall('Bash', {})).toEqual([])
    expect(r.runPostToolCall('Bash', 'x', false)).toEqual([])
    expect(r.runUserPromptSubmit('hi')).toEqual([])
    expect(r.runOnError?.(new Error('x'), { turnNumber: 1 })).toEqual([])
    expect(r.runOnComplete?.({ reason: 'stop_sequence', stopped: true, output: 'x' })).toEqual([])
    expect(r.runOnContextOverflow?.(0, 0)).toEqual([])
  })
})

describe('HookRunner — production sink wiring', () => {
  it('default constructor does not produce console noise on failure', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: 'something broke',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('boom')] }), { runner })

    r.runPreToolCall('Bash', {})

    expect(consoleSpy).not.toHaveBeenCalled()
    expect(stderrSpy).not.toHaveBeenCalled()
    expect(stdoutSpy).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
    stdoutSpy.mockRestore()
    consoleSpy.mockRestore()
  })

  it('invokes sink.warn with a structured, redacted message on failure', () => {
    const messages: string[] = []
    const sink: HookFailureSink = { warn: (m) => messages.push(m) }
    const SECRET = 'sk-redact-me-1234567890abcde'
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 2,
      signal: null,
      durationMs: 7,
      error: `leak ${SECRET} payload`,
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('my-cmd')] }), { runner, sink })

    const original = process.env.OPENAI_API_KEY
    process.env.OPENAI_API_KEY = SECRET
    try {
      r.runPreToolCall('Bash', {})
    } finally {
      if (original === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = original
    }

    expect(messages).toHaveLength(1)
    const msg = messages[0]
    expect(msg).toContain("Hook PreToolCall command 'my-cmd' failed")
    expect(msg).toContain('[non_zero]')
    expect(msg).toContain('exit 2')
    expect(msg).toContain('7ms')
    expect(msg).not.toContain(SECRET)
  })

  it('does not call sink.warn when the hook succeeds', () => {
    const sink: HookFailureSink = { warn: vi.fn() }
    const { runner } = fakeRunner(() => ({ ok: true, status: 0, signal: null, durationMs: 0 }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('ok')] }), { runner, sink })

    r.runPreToolCall('Bash', {})
    expect(sink.warn).not.toHaveBeenCalled()
  })

  it('isolates sink exceptions so the agent loop never sees them', () => {
    const sink: HookFailureSink = { warn: () => { throw new Error('renderer exploded') } }
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: 1,
      signal: null,
      durationMs: 0,
      error: 'x',
      errorCode: 'non_zero',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('bad')] }), { runner, sink })

    expect(() => r.runPreToolCall('Bash', {})).not.toThrow()
  })

  it('renders a useful message for timeout failures (signal + code)', () => {
    const sink: HookFailureSink = { warn: vi.fn() }
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: null,
      signal: 'SIGTERM',
      durationMs: 5_000,
      error: 'killed',
      errorCode: 'timeout',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('slow')] }), { runner, sink })

    r.runPreToolCall('Bash', {})
    expect(sink.warn).toHaveBeenCalledOnce()
    const msg = (sink.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(msg).toContain('[timeout]')
    expect(msg).toContain('SIGTERM')
  })

  it('renders a useful message for missing-binary failures', () => {
    const sink: HookFailureSink = { warn: vi.fn() }
    const { runner } = fakeRunner(() => ({
      ok: false,
      status: null,
      signal: null,
      durationMs: 1,
      error: 'spawn missing ENOENT',
      errorCode: 'not_found',
    }))
    const r = new HookRunner(hooks({ PreToolCall: [entry('missing')] }), { runner, sink })

    r.runPreToolCall('Bash', {})
    const msg = (sink.warn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(msg).toContain('[not_found]')
  })

  it('invokes sink.warn for every failing entry in a multi-hook list', () => {
    const sink: HookFailureSink = { warn: vi.fn() }
    const { runner } = fakeRunner((options) => options.command === 'bad'
      ? { ok: false, status: 1, signal: null, durationMs: 0, error: 'x', errorCode: 'non_zero' }
      : { ok: true, status: 0, signal: null, durationMs: 0 },
    )
    const r = new HookRunner(
      hooks({ PreToolCall: [entry('good'), entry('bad'), entry('also-bad', 'Read')] }),
      { runner, sink },
    )

    r.runPreToolCall('Bash', {})
    expect(sink.warn).toHaveBeenCalledOnce()
  })
})