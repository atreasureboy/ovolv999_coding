/**
 * Tests for the syntax highlighter utility.
 */

import { describe, it, expect } from 'vitest'
import { tokenize, highlight } from '../highlight.js'

describe('tokenize', () => {
  it('tokenizes plain text', () => {
    const tokens = tokenize('hello world', 'ts')
    expect(tokens.length).toBeGreaterThan(0)
    expect(tokens.map((t) => t.text).join('')).toBe('hello world')
  })

  it('identifies TypeScript keywords', () => {
    const tokens = tokenize('const x = 42', 'ts')
    const kw = tokens.find((t) => t.text === 'const')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies strings', () => {
    const tokens = tokenize('const s = "hello"', 'ts')
    const str = tokens.find((t) => t.text === '"hello"')
    expect(str).toBeDefined()
    expect(str?.color).toBe('green')
  })

  it('identifies single-quoted strings', () => {
    const tokens = tokenize("x = 'hi'", 'ts')
    const str = tokens.find((t) => t.text === "'hi'")
    expect(str).toBeDefined()
    expect(str?.color).toBe('green')
  })

  it('identifies numbers', () => {
    const tokens = tokenize('n = 12345', 'ts')
    const num = tokens.find((t) => t.text === '12345')
    expect(num).toBeDefined()
    expect(num?.color).toBe('yellow')
  })

  it('identifies line comments', () => {
    const tokens = tokenize('x = 1 // a comment', 'ts')
    const comment = tokens.find((t) => t.text.includes('a comment'))
    expect(comment).toBeDefined()
    expect(comment?.dim).toBe(true)
  })

  it('identifies Python-style comments', () => {
    const tokens = tokenize('x = 1  # python comment', 'python')
    const comment = tokens.find((t) => t.text.includes('python comment'))
    expect(comment).toBeDefined()
    expect(comment?.dim).toBe(true)
  })

  it('identifies function calls', () => {
    const tokens = tokenize('console.log("x")', 'ts')
    const fn = tokens.find((t) => t.text === 'log')
    expect(fn).toBeDefined()
    expect(fn?.color).toBe('blue')
  })

  it('identifies type names (capitalized)', () => {
    const tokens = tokenize('const x: MyType = 1', 'ts')
    const type = tokens.find((t) => t.text === 'MyType')
    expect(type).toBeDefined()
    expect(type?.color).toBe('cyan')
  })

  it('identifies Python keywords', () => {
    const tokens = tokenize('def hello():', 'py')
    const kw = tokens.find((t) => t.text === 'def')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies bash keywords', () => {
    const tokens = tokenize('echo "hello"', 'bash')
    const kw = tokens.find((t) => t.text === 'echo')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('handles empty input', () => {
    expect(tokenize('', 'ts')).toEqual([])
  })

  it('preserves whitespace', () => {
    const tokens = tokenize('a   b', 'ts')
    const ws = tokens.find((t) => t.text === '   ')
    expect(ws).toBeDefined()
  })

  it('identifies Go keywords', () => {
    const tokens = tokenize('func main() {}', 'go')
    const kw = tokens.find((t) => t.text === 'func')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies Rust keywords', () => {
    const tokens = tokenize('fn main() {}', 'rust')
    const kw = tokens.find((t) => t.text === 'fn')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies Java keywords', () => {
    const tokens = tokenize('public class Main {}', 'java')
    const kw = tokens.find((t) => t.text === 'class')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies C keywords', () => {
    const tokens = tokenize('int main() { return 0; }', 'c')
    const kw = tokens.find((t) => t.text === 'int')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies SQL keywords', () => {
    const tokens = tokenize('SELECT * FROM users', 'sql')
    const kw = tokens.find((t) => t.text === 'SELECT')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })

  it('identifies CSS properties', () => {
    const tokens = tokenize('color: red;', 'css')
    const kw = tokens.find((t) => t.text === 'color')
    expect(kw).toBeDefined()
    expect(kw?.color).toBe('magenta')
  })
})

describe('highlight', () => {
  it('is an alias for tokenize', () => {
    const result = highlight('const x = 1', 'ts')
    expect(result.length).toBeGreaterThan(0)
    expect(result[0].text).toBe('const')
  })

  it('handles empty string', () => {
    expect(highlight('', 'ts')).toEqual([])
  })
})
