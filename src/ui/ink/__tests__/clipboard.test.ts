import { describe, it, expect, vi, beforeEach } from 'vitest'
import { copyToClipboard } from '../../../utils/clipboard.js'

// Mock child_process
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'

describe('clipboard', () => {
  beforeEach(() => {
    vi.mocked(execFileSync).mockReset()
    // Reset the cache by re-importing — but since we can't easily do that,
    // the test works because we mock execFileSync to always succeed
  })

  it('returns true when clipboard command succeeds', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''))
    const ok = copyToClipboard('hello world')
    expect(ok).toBe(true)
  })

  it('returns false when clipboard command fails', () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('not found')
    })
    const ok = copyToClipboard('hello world')
    expect(ok).toBe(false)
  })

  it('passes input text to the clipboard command', () => {
    vi.mocked(execFileSync).mockReturnValue(Buffer.from(''))
    copyToClipboard('test content')
    const calls = vi.mocked(execFileSync).mock.calls
    // Find the call with input option
    const copyCall = calls.find((c) => {
      const opts = c[2] as { input?: string } | undefined
      return opts?.input === 'test content'
    })
    expect(copyCall).toBeDefined()
  })
})
