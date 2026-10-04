import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { cleanup, render } from 'ink-testing-library'
import { PermissionDialog } from '../../../src/ui/ink/components/PermissionDialog.js'

afterEach(() => cleanup())

describe('permission dialog scopes', () => {
  it('renders controls visibly in tool, preview, directory and persistent-rule text', async () => {
    const onResolve = vi.fn()
    const request = {
      toolName: 'Bash\u001b[2J', preview: 'echo safe\r\u001b[8m;git push\u009b2K',
      cwd: '/project\u202espoof', riskLevel: 'dangerous' as const,
      ruleSuggestion: 'Bash:npm test\u001b[8m;git push',
    }
    const view = render(createElement(PermissionDialog, { request, onResolve }))
    expect(view.lastFrame()).toContain('Bash\\u001b[2J')
    expect(view.lastFrame()).toContain('echo safe\\r\\u001b[8m;git push')
    expect(view.lastFrame()).toContain('/project\\u202espoof')
    expect(view.lastFrame()).not.toContain('\u009b')
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('r')
    await vi.waitFor(() => expect(view.lastFrame()).toContain('Bash:npm test\\u001b[8m;git push'))
    await new Promise<void>((resolve) => setImmediate(resolve))
    view.stdin.write('y')
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith(true, false, undefined, 'rule', request.ruleSuggestion))
  })

  it('renders the complete command including a long trailing mutation', () => {
    const preview = `npm test ${'--filter safe '.repeat(30)} && git push --force`
    const view = render(createElement(PermissionDialog, {
      request: { toolName: 'Bash', preview, riskLevel: 'dangerous' }, onResolve: () => {},
    }))
    expect(view.lastFrame()).toContain('git push --force')
    expect(view.lastFrame()).not.toContain('[a] always')
  })

  it('makes a session selection explicit without the legacy broad Always grant', async () => {
    const onResolve = vi.fn()
    const view = render(createElement(PermissionDialog, {
      request: { toolName: 'Bash', preview: 'npm test', cwd: '/project', riskLevel: 'needs-approval' }, onResolve,
    }))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('a')
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(onResolve).not.toHaveBeenCalled()
    view.stdin.write('s')
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith(true, false, undefined, 'session'))
  })

  it('requires confirmation of the exact displayed rule before granting it', async () => {
    const onResolve = vi.fn()
    const rule = 'Bash:npm test'
    const view = render(createElement(PermissionDialog, {
      request: { toolName: 'Bash', preview: 'npm test', riskLevel: 'needs-approval', ruleSuggestion: rule }, onResolve,
    }))
    await vi.waitFor(() => expect(view.stdin.listenerCount('readable')).toBeGreaterThan(0))
    view.stdin.write('r')
    await vi.waitFor(() => expect(view.lastFrame()).toContain(rule))
    expect(onResolve).not.toHaveBeenCalled()
    await new Promise<void>((resolve) => setImmediate(resolve))
    view.stdin.write('y')
    await vi.waitFor(() => expect(onResolve).toHaveBeenCalledWith(true, false, undefined, 'rule', rule))
  })
})
