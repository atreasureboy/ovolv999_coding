import { describe, it, expect, beforeEach } from 'vitest'
import { pasteStore } from '../pasteStore.js'

describe('pasteStore', () => {
  beforeEach(() => {
    // Reset internal state by creating fresh references via store
  })

  it('detects large paste', () => {
    expect(pasteStore.isLargePaste('short')).toBe(false)
    expect(pasteStore.isLargePaste('x'.repeat(10001))).toBe(true)
  })

  it('stores large paste and returns placeholder', () => {
    const text = 'line\n'.repeat(49) + 'line'
    const placeholder = pasteStore.store(text)
    expect(placeholder).toMatch(/^\[Pasted text #\d+ \+\d+ lines\]$/)
  })

  it('expands placeholder back to original text', () => {
    const text = 'hello\nworld\nfoo'
    const placeholder = pasteStore.store(text)
    const expanded = pasteStore.expand(`before ${placeholder} after`)
    expect(expanded).toBe(`before ${text} after`)
  })

  it('leaves non-paste text unchanged', () => {
    expect(pasteStore.expand('just regular text')).toBe('just regular text')
  })

  it('handles multiple paste references', () => {
    const p1 = pasteStore.store('content1')
    const p2 = pasteStore.store('content2')
    const expanded = pasteStore.expand(`${p1} and ${p2}`)
    expect(expanded).toBe('content1 and content2')
  })

  it('threshold is 10000 chars', () => {
    expect(pasteStore.threshold).toBe(10_000)
  })
})
