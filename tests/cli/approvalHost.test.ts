import { afterEach, describe, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { createTerminalApprovalHost, createInkApprovalHost } from '../../src/cli/approvalHost.js'
import { approvalInputDigest, type ApprovalRequest } from '../../src/core/approvalBroker.js'
import { InputHandler, type SharedPrompt } from '../../src/ui/input.js'
import { UIStore } from '../../src/ui/ink/store.js'

const handlers: InputHandler[] = []
afterEach(() => { for (const handler of handlers.splice(0)) handler.close() })

function request(signal = new AbortController().signal): ApprovalRequest {
  return { requestId: 'request', runId: 'run', operationId: 'op', tool: 'Bash', preview: `npm test ${'safe '.repeat(30)} && git push`, inputDigest: approvalInputDigest({ command: 'npm test' }), cwd: '/project', signal, riskLevel: 'dangerous', ruleSuggestion: 'Bash:npm test' }
}

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  const handler = new InputHandler({ input, output, terminal: false })
  handlers.push(handler)
  const prompt: SharedPrompt = { ...handler.sharedPrompt(), isTTY: true }
  const writes: string[] = []
  return { input, handler, writes, host: createTerminalApprovalHost({ prompt, writeOut: (text) => { writes.push(text) } }) }
}

describe('terminal approval host', () => {
  it('renders controls visibly in every untrusted approval field without changing the decision', async () => {
    const { input, writes, host } = terminal()
    const req = {
      ...request(), tool: 'Bash\u001b[2J', cwd: '/project\rspoof',
      preview: 'echo safe\n\u001b[8m;git push\u001b[0m\u0000\u009b2K\u202eevil',
      ruleSuggestion: 'Bash:npm test\u001b[8m;git push',
    }
    const pending = host.request(req)
    input.write('r\n')
    await vi.waitFor(() => expect(writes.join('')).toContain('Persist this exact rule'))
    input.write('y\n')
    await expect(pending).resolves.toMatchObject({ action: 'allow', scope: 'rule', rule: req.ruleSuggestion, cwd: req.cwd })
    const rendered = writes.join('')
    for (const control of ['\u0000', '\u001b', '\u009b', '\r', '\u202e']) expect(rendered).not.toContain(control)
    expect(rendered).toContain('Bash\\u001b[2J')
    expect(rendered).toContain('/project\\rspoof')
    expect(rendered).toContain('echo safe\\n\\u001b[8m;git push')
    expect(rendered).toContain('Bash:npm test\\u001b[8m;git push')
  })

  it('uses the shared prompt, prints the full command and approves only once', async () => {
    const { input, writes, host, handler } = terminal()
    const pending = host.request(request())
    expect(writes.join('')).toContain('&& git push')
    expect(writes.join('')).toContain('/project')
    input.write('y\n')
    await expect(pending).resolves.toMatchObject({ action: 'allow', scope: 'once', status: 'decided' })
    const ordinary = handler.readLine('normal: ')
    input.write('ordinary REPL input\n')
    await expect(ordinary).resolves.toEqual({ text: 'ordinary REPL input', eof: false })
  })

  it('does not consume another line after an unknown approval response', async () => {
    const { input, host, handler } = terminal()
    const pending = host.request(request())
    input.write('next task\n')
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'decided' })
    const ordinary = handler.readLine('normal: ')
    input.write('next task again\n')
    await expect(ordinary).resolves.toMatchObject({ text: 'next task again' })
  })

  it('returns only an explicit session decision for the same operation option', async () => {
    const { input, host } = terminal()
    const pending = host.request(request())
    input.write('s\n')
    await expect(pending).resolves.toMatchObject({ action: 'allow', scope: 'session' })
  })

  it('cancels only its shared read and leaves the ordinary prompt usable', async () => {
    const { input, host, handler } = terminal()
    const controller = new AbortController()
    const pending = host.request(request(controller.signal))
    controller.abort()
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'cancelled' })
    const ordinary = handler.readLine('normal: ')
    input.write('still usable\n')
    await expect(ordinary).resolves.toMatchObject({ text: 'still usable', eof: false })
  })

  it('returns needs_input without reading or closing a noninteractive prompt', async () => {
    const readLine = vi.fn(() => Promise.resolve({ text: '', eof: true }))
    const close = vi.fn()
    const host = createTerminalApprovalHost({ prompt: { isTTY: false, readLine, close }, writeOut: () => {} })
    await expect(host.request(request())).resolves.toMatchObject({ action: 'deny', status: 'needs_input' })
    expect(readLine).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
  })

  it('requires a separate confirmation for the displayed exact persistent rule', async () => {
    const { input, writes, host } = terminal()
    const pending = host.request(request())
    input.write('r\n')
    await vi.waitFor(() => expect(writes.join('')).toContain('Bash:npm test'))
    input.write('y\n')
    await expect(pending).resolves.toMatchObject({ action: 'allow', scope: 'rule', rule: 'Bash:npm test' })
  })
})

describe('Ink approval host', () => {
  it('maps explicit operation scope and cancellation without granting a wildcard', async () => {
    const store = new UIStore()
    const host = createInkApprovalHost(store)
    const pending = host.request(request())
    expect(store.getState().pendingPermission?.preview).toContain('&& git push')
    store.resolvePermission(true, false, undefined, 'session')
    await expect(pending).resolves.toMatchObject({ action: 'allow', scope: 'session' })
    const controller = new AbortController()
    const cancelled = host.request(request(controller.signal))
    controller.abort()
    await expect(cancelled).resolves.toMatchObject({ action: 'deny', status: 'cancelled' })
    expect(store.getState().pendingPermission).toBeNull()
  })
})
