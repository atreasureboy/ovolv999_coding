import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArgError, parseArgs } from '../../src/cli/args.js'
import { SESSION_SUBCOMMANDS } from '../../src/cli/sessions.js'

beforeEach(() => {
  for (const name of [
    'OVOGO_MODEL',
    'OVOGO_MAX_ITER',
    'OVOGO_CWD',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
  ])
    vi.stubEnv(name, undefined)
})

afterEach(() => vi.unstubAllEnvs())

const parse = (...args: string[]) => parseArgs(['node', 'ovolv999', ...args])

describe('CLI arguments', () => {
  it('preserves environment defaults and explicit overrides', () => {
    vi.stubEnv('OVOGO_MODEL', 'local-model')
    vi.stubEnv('OVOGO_MAX_ITER', '17')
    expect(parse()).toMatchObject({
      model: 'local-model',
      maxIter: 17,
      loopMaxIters: 12,
      pipeFormat: 'text',
    })
    expect(parse('-m', 'explicit', '--max-iter', '3', 'first', 'second')).toMatchObject({
      model: 'explicit',
      maxIter: 3,
      task: 'first second',
    })
  })

  it.each(['bad', '0', '-2'])(
    'uses the safe iteration default for environment value %s',
    (value) => {
      vi.stubEnv('OVOGO_MAX_ITER', value)
      expect(parse().maxIter).toBe(200)
    },
  )

  it.each(['--model', '--cwd', '--max-iter', '--loop-max-iters', '--resume', '--format'])(
    'rejects missing %s values before startup',
    (flag) => {
      expect(() => parse(flag)).toThrow(ArgError)
      expect(() => parse(flag, '--help')).toThrow(`${flag} requires a value`)
    },
  )

  it.each(['--max-iter', '--loop-max-iters'])('rejects invalid %s values', (flag) => {
    expect(() => parse(flag, 'zero')).toThrow(`${flag} must be a positive integer`)
    expect(() => parse(flag, '0')).toThrow(ArgError)
  })

  it('retains positive numeric-prefix parsing for existing callers', () => {
    expect(parse('--max-iter', '4suffix').maxIter).toBe(4)
  })

  it('accepts supported pipe formats and rejects unknown formats', () => {
    expect(parse('--pipe', '--format', 'json')).toMatchObject({ pipe: true, pipeFormat: 'json' })
    expect(() => parse('--format', 'xml')).toThrow('--format must be "text" or "json"')
  })

  it('keeps flags and session references independent from the positional prompt', () => {
    expect(
      parse(
        '--ink',
        '--bg',
        '--loop',
        '--loop-max-iters',
        '7',
        '-c',
        '-r',
        'session_one',
        '-V',
        '-h',
        'task',
      ),
    ).toMatchObject({
      ink: true,
      bg: true,
      loop: true,
      loopMaxIters: 7,
      continueSession: true,
      resumeSession: 'session_one',
      version: true,
      help: true,
      task: 'task',
    })
  })
})

describe('early session routing', () => {
  it('recognizes each existing alias', () => {
    expect([...SESSION_SUBCOMMANDS]).toEqual([
      ['ps', 'ps'],
      ['sessions', 'ps'],
      ['attach', 'attach'],
      ['logs', 'logs'],
      ['stop', 'stop'],
      ['rm', 'rm'],
      ['remove', 'rm'],
      ['clean', 'clean'],
    ])
  })

  it.each(['constructor', 'toString', '__proto__'])(
    'leaves the literal task %s for task parsing',
    (task) => {
      expect(SESSION_SUBCOMMANDS.get(task)).toBeUndefined()
      expect(parse(task).task).toBe(task)
    },
  )
})
