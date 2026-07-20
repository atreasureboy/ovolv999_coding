import { describe, expect, it } from 'vitest'
import { ThinkingTagFilter } from '../src/core/thinkingTagFilter.js'

describe('ThinkingTagFilter', () => {
  it('removes a complete thinking block', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('<think>private reasoning</think>OK')).toBe('OK')
    expect(filter.finish()).toBe('')
  })

  it('handles tags split across stream chunks', () => {
    const filter = new ThinkingTagFilter()
    const chunks = ['<thi', 'nk>reason', 'ing</th', 'ink>', 'visible']
    expect(chunks.map(chunk => filter.push(chunk)).join('') + filter.finish()).toBe('visible')
  })

  it('preserves ordinary angle-bracket content', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('Use <thing>value</thing>.') + filter.finish()).toBe('Use <thing>value</thing>.')
  })

  it('drops an unterminated thinking block at end of stream', () => {
    const filter = new ThinkingTagFilter()
    expect(filter.push('before<think>secret')).toBe('before')
    expect(filter.finish()).toBe('')
  })

  it('captures thinking content via drainThinking()', () => {
    const filter = new ThinkingTagFilter()
    filter.push('<think>my reasoning</think>')
    expect(filter.drainThinking()).toBe('my reasoning')
  })

  it('drainThinking returns empty when no thinking occurred', () => {
    const filter = new ThinkingTagFilter()
    filter.push('just regular text')
    expect(filter.drainThinking()).toBe('')
  })

  it('captures thinking split across chunks', () => {
    const filter = new ThinkingTagFilter()
    let thinking = ''
    const chunks = ['<thi', 'nk>reason', 'ing</th', 'ink>', 'visible']
    for (const c of chunks) {
      filter.push(c)
      thinking += filter.drainThinking()
    }
    filter.finish()
    thinking += filter.drainThinking()
    expect(thinking).toBe('reasoning')
  })

  it('captures unterminated thinking content via drainThinking after finish', () => {
    const filter = new ThinkingTagFilter()
    filter.push('before<think>secret')
    filter.finish()
    expect(filter.drainThinking()).toBe('secret')
  })
})
