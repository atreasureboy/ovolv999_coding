import { describe, expect, it } from 'vitest'
import { ArgError } from '../../src/cli/args.js'
import { parseExecArgs } from '../../src/cli/execArgs.js'

const parse = (...args: string[]) => parseExecArgs(['exec', ...args])

describe('exec arguments', () => {
  it('parses an explicit JSONL task without including exec', () => {
    expect(parse('--jsonl', 'read', '你好 🌏')).toEqual({
      jsonl: true,
      task: 'read 你好 🌏',
      continueSession: false,
    })
    expect(parse('--jsonl')).toEqual({ jsonl: true, task: '', continueSession: false })
  })

  it('keeps the legacy parser and stdin processing outside this parser', () => {
    expect(() => parseExecArgs(['node', 'ovolv999', 'exec', '--jsonl'])).toThrow(ArgError)
    expect(() => parseExecArgs(['--jsonl'])).toThrow(ArgError)
    expect(() => parseExecArgs([])).toThrow(ArgError)
  })

  it('accepts the explicitly supported flags and preserves supplied values', () => {
    expect(
      parse(
        '--jsonl',
        '--cwd',
        './work space',
        '--model',
        'fixture',
        '--effort',
        'maximum',
        '--output-schema',
        './schema.json',
        '--resume',
        'session_123',
        'task',
      ),
    ).toEqual({
      jsonl: true,
      task: 'task',
      continueSession: false,
      cwd: './work space',
      model: 'fixture',
      effort: 'maximum',
      outputSchemaPath: './schema.json',
      resume: 'session_123',
    })
    expect(parse('--jsonl', '--continue')).toMatchObject({ continueSession: true })
  })

  it('allows literal flags after -- and preserves whitespace inside task arguments', () => {
    expect(parse('--jsonl', ' first ', '--', '--pipe', '--model', ' a\nb ')).toMatchObject({
      task: ' first  --pipe --model  a\nb ',
    })
    expect(() => parse('--', '--jsonl')).toThrow('--jsonl is required')
  })

  it.each(['--cwd', '--model', '--effort', '--resume', '--output-schema'])(
    'rejects missing or empty %s values',
    (flag) => {
      expect(() => parse('--jsonl', flag)).toThrow(`${flag} requires a value`)
      expect(() => parse('--jsonl', flag, '')).toThrow(`${flag} requires a value`)
      expect(() => parse('--jsonl', flag, '--continue')).toThrow(`${flag} requires a value`)
    },
  )

  it.each([
    '--pipe',
    '--ink',
    '--loop',
    '--bg',
    '--format',
    '--unknown',
    '-m',
    '-h',
    '--jsonl=true',
  ])('rejects the unsupported flag %s', (flag) => {
    expect(() => parse('--jsonl', flag)).toThrow(ArgError)
  })

  it('rejects conflicting session selectors in either order', () => {
    expect(() => parse('--jsonl', '--resume', 'session_123', '--continue')).toThrow(ArgError)
    expect(() => parse('--jsonl', '--continue', '--resume', 'session_123')).toThrow(ArgError)
  })

  it('requires explicit JSONL mode and validates effort values strictly', () => {
    expect(() => parse('task')).toThrow('--jsonl is required')
    for (const value of ['minimal', 'low', 'medium', 'high', 'maximum'])
      expect(parse('--jsonl', '--effort', value).effort).toBe(value)
    expect(() => parse('--jsonl', '--effort', 'xhigh')).toThrow(ArgError)
  })

  it('rejects duplicate flags instead of silently changing the selected mode or value', () => {
    expect(() => parse('--jsonl', '--jsonl')).toThrow(ArgError)
    expect(() => parse('--jsonl', '--model', 'first', '--model', 'second')).toThrow(ArgError)
  })
})
