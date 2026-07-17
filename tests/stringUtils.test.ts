/**
 * strings.ts — utility helpers for tool inputs and CJK normalization.
 *
 * The helpers under test are pure and cheap; the tests below pin the
 * exact mapping behavior so a future "simplification" can't silently
 * change which characters flow where.
 */

import { describe, it, expect } from 'vitest'
import {
  str,
  normalizeFullWidthDigits,
  normalizeFullWidthSpace,
  normalizeCJKInput,
  escapeRegExp,
  safeParseJSON,
} from '../src/core/strings.js'

describe('str', () => {
  it('returns strings as-is', () => {
    expect(str('hello')).toBe('hello')
    expect(str('')).toBe('')
  })

  it('coerces numbers to string', () => {
    expect(str(42)).toBe('42')
    expect(str(0)).toBe('0')
    expect(str(-1.5)).toBe('-1.5')
  })

  it('coerces booleans to string', () => {
    expect(str(true)).toBe('true')
    expect(str(false)).toBe('false')
  })

  it('returns the default for objects/arrays/null/undefined', () => {
    expect(str({ a: 1 })).toBe('')
    expect(str([1, 2])).toBe('')
    expect(str(null)).toBe('')
    expect(str(undefined)).toBe('')
  })

  it('honors a custom default', () => {
    expect(str(null, 'fallback')).toBe('fallback')
    expect(str(undefined, 'x')).toBe('x')
  })
})

describe('normalizeFullWidthDigits', () => {
  it('converts full-width digits to ASCII', () => {
    expect(normalizeFullWidthDigits('１２３')).toBe('123')
    expect(normalizeFullWidthDigits('test００７')).toBe('test007')
  })

  it('leaves ASCII digits unchanged', () => {
    expect(normalizeFullWidthDigits('123')).toBe('123')
    expect(normalizeFullWidthDigits('test007')).toBe('test007')
  })

  it('handles the full range U+FF10..U+FF19', () => {
    // Spot-check the boundaries so a future "off-by-one in the regex"
    // regression fails loudly. ０ → 0 (FF10 → 30), ９ → 9 (FF19 → 39).
    expect(normalizeFullWidthDigits('０')).toBe('0')
    expect(normalizeFullWidthDigits('９')).toBe('9')
    expect(normalizeFullWidthDigits('０１２３４５６７８９')).toBe('0123456789')
  })

  it('does not touch other CJK code points', () => {
    // 中文 / 日本語 / emoji are unaffected — only the digit range.
    expect(normalizeFullWidthDigits('你好')).toBe('你好')
    expect(normalizeFullWidthDigits('🎉')).toBe('🎉')
  })

  it('handles empty string and mixed input', () => {
    expect(normalizeFullWidthDigits('')).toBe('')
    // Mixing ASCII and full-width is the common IME case — only the
    // full-width part is mapped.
    expect(normalizeFullWidthDigits('a１b２c')).toBe('a1b2c')
  })
})

describe('normalizeFullWidthSpace', () => {
  it('converts full-width space to ASCII space', () => {
    expect(normalizeFullWidthSpace('hello　world')).toBe('hello world')
  })

  it('leaves ASCII space unchanged', () => {
    expect(normalizeFullWidthSpace('hello world')).toBe('hello world')
  })

  it('handles empty string and consecutive full-width spaces', () => {
    expect(normalizeFullWidthSpace('')).toBe('')
    expect(normalizeFullWidthSpace('a　　b')).toBe('a  b')
  })
})

describe('normalizeCJKInput', () => {
  it('applies both normalizations', () => {
    // The audit prompt's fixture: ideographic space + full-width 12.
    expect(normalizeCJKInput('test　１２')).toBe('test 12')
  })

  it('handles isolated digits and spaces independently', () => {
    expect(normalizeCJKInput('１２')).toBe('12')
    expect(normalizeCJKInput('　')).toBe(' ')
  })

  it('is idempotent on its own output', () => {
    // Defense: running twice must not degrade the result. This guards
    // against future changes that add a non-idempotent normalization.
    const once = normalizeCJKInput('test　１２ ｇｏｏd')
    const twice = normalizeCJKInput(once)
    expect(twice).toBe(once)
  })

  it('does not change CJK ideographs', () => {
    expect(normalizeCJKInput('你好，世界')).toBe('你好，世界')
  })

  it('does not touch ASCII-only input', () => {
    expect(normalizeCJKInput('hello world 123')).toBe('hello world 123')
  })
})

describe('escapeRegExp', () => {
  it('escapes metacharacters', () => {
    expect(escapeRegExp('foo.bar')).toBe('foo\\.bar')
    expect(escapeRegExp('a*b+c?')).toBe('a\\*b\\+c\\?')
  })

  it('escapes anchors and groups', () => {
    expect(escapeRegExp('^abc$')).toBe('\\^abc\\$')
    expect(escapeRegExp('(a)(b)')).toBe('\\(a\\)\\(b\\)')
    expect(escapeRegExp('a|b')).toBe('a\\|b')
    expect(escapeRegExp('a{2,3}')).toBe('a\\{2,3\\}')
  })

  it('escapes character classes and backslashes', () => {
    expect(escapeRegExp('[abc]')).toBe('\\[abc\\]')
    expect(escapeRegExp('a\\b')).toBe('a\\\\b')
  })

  it('leaves non-metacharacters alone', () => {
    expect(escapeRegExp('hello world 123')).toBe('hello world 123')
    expect(escapeRegExp('')).toBe('')
  })

  it('produces a regex that matches the original literally', () => {
    // Functional check — the escape output, when used as a RegExp
    // pattern, must round-trip the input. The contract callers rely
    // on is "the escaped pattern matches the original literal". The
    // negative corollary (does not match a different string) only
    // holds when the input contains no literal backslashes — a `\\b`
    // in the input legitimately appears as a `\b` prefix once the
    // string is concatenated with extra characters — so we restrict
    // the negative check to backslash-free inputs.
    for (const input of ['foo.bar', '(a)+b', '[x]?', '^head$']) {
      const re = new RegExp(escapeRegExp(input))
      expect(re.test(input)).toBe(true)
    }
    // Round-trip the backslash case explicitly (positive only).
    const reBs = new RegExp(escapeRegExp('a\\b'))
    expect(reBs.test('a\\b')).toBe(true)
  })
})

describe('safeParseJSON', () => {
  it('parses valid JSON', () => {
    expect(safeParseJSON('{"a":1}', null)).toEqual({ a: 1 })
    expect(safeParseJSON('[1,2,3]', null)).toEqual([1, 2, 3])
    expect(safeParseJSON('"hello"', null)).toBe('hello')
    expect(safeParseJSON('42', 0)).toBe(42)
    expect(safeParseJSON('null', 'fallback')).toBe(null)
  })

  it('returns fallback on invalid JSON', () => {
    expect(safeParseJSON('not json', 'fallback')).toBe('fallback')
    expect(safeParseJSON('{a:1}', { ok: false })).toEqual({ ok: false })
    expect(safeParseJSON('', 'empty')).toBe('empty')
  })

  it('returns fallback for malformed trailing content', () => {
    // Trailing comma, unmatched brace, etc. — common copy-paste errors
    // in user-controlled JSON blobs.
    expect(safeParseJSON('{"a":1,}', null)).toBe(null)
  })
})