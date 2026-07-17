import { describe, it, expect } from 'vitest'
import { Writable } from 'stream'
import { SlashSuggester, type SlashSuggesterSource } from '../slashSuggest.js'

class CaptureStream extends Writable {
  data = ''
  override _write(chunk: Buffer | string, _enc: string, cb: () => void): void {
    this.data += chunk.toString()
    cb()
  }
}

function src(): SlashSuggesterSource {
  return {
    isTTY: true,
    getCommands: () => [
      { name: 'help', description: 'Show help' },
      { name: 'history', description: 'Show history' },
      { name: 'resume', description: 'Resume session' },
    ],
    getSkills: () => [{ name: 'release', description: 'Release helper' }],
  }
}

function makeSuggester(getLine: () => string, enabled = true) {
  const stream = new CaptureStream()
  const s = new SlashSuggester({ source: src(), stream, getLine, enabled })
  return { s, stream }
}

describe('SlashSuggester.complete', () => {
  it('returns slash-prefixed command names', () => {
    const { s } = makeSuggester(() => '/h')
    const [matches] = s.complete('/h')
    expect(matches.length).toBeGreaterThan(0)
    expect(matches).toContain('/help')
    expect(matches).toContain('/history')
  })

  it('returns no matches for non-slash input', () => {
    const { s } = makeSuggester(() => 'foo')
    const [matches] = s.complete('foo')
    expect(matches).toEqual([])
  })

  it('returns no matches once the line has a space (args present)', () => {
    const { s } = makeSuggester(() => '/help 5')
    const [matches] = s.complete('/help 5')
    expect(matches).toEqual([])
  })

  it('returns no matches when nothing matches', () => {
    const { s } = makeSuggester(() => '/zzzz')
    const [matches] = s.complete('/zzzz')
    expect(matches).toEqual([])
  })

  it('is a no-op when disabled', () => {
    const { s } = makeSuggester(() => '/h', false)
    const [matches] = s.complete('/h')
    expect(matches).toEqual([])
  })
})

describe('SlashSuggester.refresh', () => {
  it('renders an overlay when line is a slash prefix', () => {
    const { s, stream } = makeSuggester(() => '/h')
    s.refresh()
    expect(stream.data).toContain('/help')
    expect(stream.data).toContain('/history')
    // Newline below the prompt + move-up escape so the prompt stays put
    expect(stream.data).toContain('\n')
    const ESC = String.fromCharCode(0x1b)
    expect(stream.data).toContain(ESC + '[')
  })

  it('renders on repeated calls without throwing', () => {
    const { s, stream } = makeSuggester(() => '/h')
    s.refresh()
    const afterRender = stream.data
    expect(afterRender).toContain('/help')
    s.refresh()
    expect(stream.data.length).toBeGreaterThanOrEqual(afterRender.length)
  })

  it('does nothing when disabled', () => {
    const { s, stream } = makeSuggester(() => '/h', false)
    s.refresh()
    expect(stream.data).toBe('')
  })

  it('does nothing for empty / non-slash input', () => {
    const { s, stream } = makeSuggester(() => '')
    s.refresh()
    expect(stream.data).toBe('')
  })

  it('does nothing when line has a space (already a command invocation)', () => {
    const { s, stream } = makeSuggester(() => '/help 5')
    s.refresh()
    expect(stream.data).toBe('')
  })
})
