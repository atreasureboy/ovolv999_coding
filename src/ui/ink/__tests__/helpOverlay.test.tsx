/**
 * HelpOverlay component rendering test.
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { HelpOverlay } from '../components/HelpOverlay.js'

describe('HelpOverlay rendering', () => {
  it('renders title and shortcut groups', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Keyboard Shortcuts')
    expect(frame).toContain('Input')
    expect(frame).toContain('Navigation')
    expect(frame).toContain('Slash Commands')
    expect(frame).toContain('Permissions')
  })

  it('includes key shortcuts', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Enter')
    expect(frame).toContain('Ctrl+J')
    expect(frame).toContain('/model')
    expect(frame).toContain('/resume')
    expect(frame).toContain('ESC')
  })

  it('shows dismiss hint', () => {
    const { lastFrame } = render(<HelpOverlay onDismiss={() => {}} />)
    expect((lastFrame() ?? '')).toContain('dismiss')
  })
})
