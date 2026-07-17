/**
 * DiffView tests — computeLineDiff pure function + rendering.
 */

import { describe, it, expect } from 'vitest'
import { computeLineDiff, type DiffLine } from '../components/DiffView.js'

describe('computeLineDiff', () => {
  it('returns empty for identical text', () => {
    const diff = computeLineDiff('hello\nworld', 'hello\nworld')
    expect(diff.every((l: DiffLine) => l.type === 'context')).toBe(true)
  })

  it('detects added lines', () => {
    const diff = computeLineDiff('line1\nline3', 'line1\nline2\nline3')
    const adds = diff.filter((l: DiffLine) => l.type === 'add')
    expect(adds).toHaveLength(1)
    expect(adds[0].text).toBe('line2')
  })

  it('detects removed lines', () => {
    const diff = computeLineDiff('line1\nline2\nline3', 'line1\nline3')
    const removes = diff.filter((l: DiffLine) => l.type === 'remove')
    expect(removes).toHaveLength(1)
    expect(removes[0].text).toBe('line2')
  })

  it('detects modified lines (remove + add)', () => {
    const diff = computeLineDiff('old line', 'new line')
    const removes = diff.filter((l: DiffLine) => l.type === 'remove')
    const adds = diff.filter((l: DiffLine) => l.type === 'add')
    expect(removes).toHaveLength(1)
    expect(adds).toHaveLength(1)
    expect(removes[0].text).toBe('old line')
    expect(adds[0].text).toBe('new line')
  })

  it('includes context lines around the change', () => {
    const old = 'ctx1\nctx2\nchanged\nctx3\nctx4'
    const newText = 'ctx1\nctx2\nmodified\nctx3\nctx4'
    const diff = computeLineDiff(old, newText)
    // Should have context before + remove + add + context after
    const contextLines = diff.filter((l: DiffLine) => l.type === 'context')
    expect(contextLines.length).toBeGreaterThan(0)
    expect(contextLines.some((l) => l.text === 'ctx1' || l.text === 'ctx2')).toBe(true)
    expect(contextLines.some((l) => l.text === 'ctx3' || l.text === 'ctx4')).toBe(true)
  })

  it('handles empty old text', () => {
    const diff = computeLineDiff('', 'new content')
    const adds = diff.filter((l) => l.type === 'add')
    expect(adds.length).toBeGreaterThan(0)
  })

  it('handles empty new text', () => {
    const diff = computeLineDiff('old content', '')
    const removes = diff.filter((l) => l.type === 'remove')
    expect(removes.length).toBeGreaterThan(0)
  })

  it('handles both empty', () => {
    const diff = computeLineDiff('', '')
    expect(diff.every((l) => l.type === 'context')).toBe(true)
  })

  it('detects multiple changes in the middle', () => {
    const old = 'a\nb\nc\nd\ne'
    const newText = 'a\nB\nC\nd\ne'
    const diff = computeLineDiff(old, newText)
    const removes = diff.filter((l) => l.type === 'remove')
    const adds = diff.filter((l) => l.type === 'add')
    expect(removes).toHaveLength(2) // b, c removed
    expect(adds).toHaveLength(2) // B, C added
  })
})
