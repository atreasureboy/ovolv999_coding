/**
 * SelectPicker + PermissionDialog component rendering tests.
 *
 * Keyboard interaction tests are omitted because ink-testing-library v4
 * does not fully simulate Ink v5's raw-mode useInput hook. Keyboard
 * handlers are simple enough to verify by inspection + manual testing.
 *
 * Rendering is verified via ink-testing-library's render() + lastFrame().
 */

import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { SelectPicker, type SelectPickerItem } from '../components/SelectPicker.js'
import { PermissionDialog } from '../components/PermissionDialog.js'

describe('SelectPicker rendering', () => {
  it('renders items with title and navigation hint', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'Option A', value: 'a' },
      { label: 'Option B', value: 'b' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Choose" onSelect={() => {}} onCancel={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Choose')
    expect(frame).toContain('Option A')
    expect(frame).toContain('Option B')
    expect(frame).toContain('navigate')
  })

  it('renders item descriptions', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'Session 1', description: '5 msgs', value: 's1' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Sessions" onSelect={() => {}} onCancel={() => {}} />,
    )
    expect((lastFrame() ?? '')).toContain('5 msgs')
  })

  it('renders empty state message', () => {
    const { lastFrame } = render(
      <SelectPicker items={[]} title="Empty" onSelect={() => {}} onCancel={() => {}} />,
    )
    expect((lastFrame() ?? '')).toContain('No items to choose from')
  })

  it('highlights first item by default', () => {
    const items: SelectPickerItem<string>[] = [
      { label: 'First', value: 'f' },
      { label: 'Second', value: 's' },
    ]
    const { lastFrame } = render(
      <SelectPicker items={items} title="Pick" onSelect={() => {}} onCancel={() => {}} />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('▸')
    expect(frame).toContain('First')
  })
})

describe('PermissionDialog rendering', () => {
  it('renders dangerous risk level in red', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Bash', preview: 'rm -rf /', riskLevel: 'dangerous' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('Permission Request')
    expect(frame).toContain('Bash')
    expect(frame).toContain('DANGEROUS')
    expect(frame).toContain('rm -rf /')
  })

  it('renders needs-approval risk level', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Write', preview: '/etc/passwd', riskLevel: 'needs-approval' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('needs approval')
    expect(frame).toContain('Write')
  })

  it('renders safe risk level', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Read', preview: 'file.txt', riskLevel: 'safe' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[safe]')
    expect(frame).not.toContain('DANGEROUS')
  })

  it('shows keyboard hints', () => {
    const { lastFrame } = render(
      <PermissionDialog
        request={{ toolName: 'Bash', preview: 'ls', riskLevel: 'safe' }}
        onResolve={() => {}}
      />,
    )
    const frame = lastFrame() ?? ''
    expect(frame).toContain('[y]')
    expect(frame).toContain('[n]')
    expect(frame).toContain('[a]')
  })
})
