import { describe, expect, it } from 'vitest'
import { BoundedOutputBuffer } from '../src/tools/boundedOutput.js'

describe('bounded command output', () => {
  it('preserves a multibyte character spanning the head and tail when nothing was dropped', () => {
    const output = new BoundedOutputBuffer(4)
    output.append('abcédef')
    expect(output.render()).toBe('abcédef')
  })
  it('retains all output through the combined head and tail budget', () => {
    const output = new BoundedOutputBuffer(4)
    output.append('ab')
    output.append('cdef')
    output.append('gh')
    expect(output.render()).toBe('abcdefgh')
  })

  it('keeps the first and most recent bytes when one large chunk exceeds the budget', () => {
    const output = new BoundedOutputBuffer(4)
    output.append('abcdefghijkl')
    expect(output.render()).toBe('abcd\n\n[... 4 bytes of live output dropped from the middle (kept 4 bytes at head + 4 bytes at tail) ...]\nijkl')
  })

  it('continues sliding the tail after output is truncated', () => {
    const output = new BoundedOutputBuffer(4)
    for (const chunk of ['abc', 'defgh', 'ijkl', 'mn']) output.append(chunk)
    expect(output.render()).toBe('abcd\n\n[... 6 bytes of live output dropped from the middle (kept 4 bytes at head + 4 bytes at tail) ...]\nklmn')
  })

  it('counts dropped multibyte output in UTF-8 bytes', () => {
    const output = new BoundedOutputBuffer(4)
    output.append('éé你你éé')
    expect(output.render()).toBe('éé\n\n[... 6 bytes of live output dropped from the middle (kept 4 bytes at head + 4 bytes at tail) ...]\néé')
  })
})
