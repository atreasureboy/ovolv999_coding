/**
 * pathSecurity — defensive helpers for filesystem paths.
 *
 * The functions in src/core/pathSecurity.ts are tiny but high-impact:
 * each is a one-line check that catches a category of input that
 * downstream tools could otherwise mishandle. The tests pin each
 * helper to a small, behavior-defining set of inputs so a future
 * "simplification" can't silently regress the security contract.
 */

import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { homedir } from 'os'
import {
  containsPathTraversal,
  containsNullByte,
  expandPath,
} from '../src/core/pathSecurity.js'

describe('pathSecurity', () => {
  describe('containsPathTraversal', () => {
    it('detects basic traversal', () => {
      expect(containsPathTraversal('../etc/passwd')).toBe(true)
      expect(containsPathTraversal('foo/../../bar')).toBe(true)
    })

    it('allows legitimate paths', () => {
      expect(containsPathTraversal('src/foo.ts')).toBe(false)
      expect(containsPathTraversal('./src/foo.ts')).toBe(false)
    })

    it('detects traversal at end of path', () => {
      // A bare `..` as the final component is still traversal — the
      // caller can't know what it resolves to without a base directory.
      expect(containsPathTraversal('foo/..')).toBe(true)
      expect(containsPathTraversal('..')).toBe(true)
    })

    it('detects Windows-style traversal', () => {
      expect(containsPathTraversal('..\\windows\\system32')).toBe(true)
      expect(containsPathTraversal('foo\\..\\bar')).toBe(true)
    })

    it('does NOT flag `..` embedded inside a longer name', () => {
      // `foo..bar` is a legitimate filename (common in backup naming,
      // versioned snapshots, etc.) and not a traversal.
      expect(containsPathTraversal('foo..bar')).toBe(false)
      expect(containsPathTraversal('my..backup.txt')).toBe(false)
    })

    it('handles absolute paths', () => {
      expect(containsPathTraversal('/etc/passwd')).toBe(false)
      expect(containsPathTraversal('/var/../etc/passwd')).toBe(true)
    })
  })

  describe('containsNullByte', () => {
    it('detects null bytes', () => {
      expect(containsNullByte('file\0.txt')).toBe(true)
      expect(containsNullByte('file.txt')).toBe(false)
    })

    it('detects null byte at any position', () => {
      expect(containsNullByte('\0start')).toBe(true)
      expect(containsNullByte('mid\0dle')).toBe(true)
      expect(containsNullByte('end\0')).toBe(true)
    })

    it('does not flag empty string', () => {
      expect(containsNullByte('')).toBe(false)
    })
  })

  describe('expandPath', () => {
    it('expands ~/', () => {
      expect(expandPath('~/foo')).toBe(join(homedir(), 'foo'))
      expect(expandPath('~/projects/ovolv999/src')).toBe(
        join(homedir(), 'projects/ovolv999/src'),
      )
    })

    it('expands bare ~ to home', () => {
      expect(expandPath('~')).toBe(homedir())
    })

    it('returns non-tilde paths unchanged', () => {
      expect(expandPath('/etc/passwd')).toBe('/etc/passwd')
      expect(expandPath('relative/path')).toBe('relative/path')
      expect(expandPath('./foo')).toBe('./foo')
    })

    it('throws on null byte', () => {
      expect(() => expandPath('file\0.txt')).toThrow(/null byte/)
    })

    it('does not expand ~ in the middle of a path', () => {
      // Only leading `~` is expanded. `foo/~bar` is a relative path
      // with a literal tilde — not a home reference.
      expect(expandPath('foo/~bar')).toBe('foo/~bar')
    })

    it('handles paths with traversal — does not pre-validate', () => {
      // expandPath deliberately does NOT reject `..`; that's a
      // separate concern from `~` expansion. The two checks live
      // in different functions so callers can apply each policy
      // independently.
      const expanded = expandPath('~/foo/../bar')
      expect(expanded).toBe(join(homedir(), 'foo/../bar'))
    })
  })
})