import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setTerminalTitle } from '../../utils/terminalTitle.js'

describe('terminalTitle', () => {
  beforeEach(() => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  })

  it('writes OSC escape sequence for title', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    setTerminalTitle('test title')
    expect(spy).toHaveBeenCalledWith('\x1b]0;test title\x07')
    spy.mockRestore()
  })

  it('handles special characters in title', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    setTerminalTitle('ovolv999 · gpt-4o · working')
    const call = spy.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0]).includes('gpt-4o'),
    )
    expect(call).toBeDefined()
    spy.mockRestore()
  })
})
