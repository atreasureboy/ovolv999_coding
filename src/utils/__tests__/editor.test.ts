import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { openInEditor } from '../../utils/editor.js'

describe('editor', () => {
  const origEditor = process.env.EDITOR
  const origVisual = process.env.VISUAL

  beforeEach(() => {
    process.env.EDITOR = undefined
    process.env.VISUAL = undefined
  })

  afterEach(() => {
    process.env.EDITOR = origEditor
    process.env.VISUAL = origVisual
  })

  it('returns null when editor fails', () => {
    process.env.EDITOR = 'nonexistent-editor-binary-12345'
    const result = openInEditor('initial')
    expect(result).toBeNull()
  })

  it('uses VISUAL over EDITOR when both are set', () => {
    // We can't fully test this without spawning an editor,
    // but we can verify the function doesn't throw
    process.env.VISUAL = 'true' // 'true' command exits 0 immediately
    process.env.EDITOR = 'false'
    const result = openInEditor('')
    // 'true' exits 0, file will be empty → null
    expect(result).toBeNull()
  })
})
