import { describe, expect, it, vi } from 'vitest'
import { ApprovalBroker, approvalInputDigest, type ApprovalDecision, type ApprovalRequest } from '../../src/core/approvalBroker.js'

function request(id: string, input: Record<string, unknown> & { command: string } = { command: 'npm test' }, cwd = '/project'): ApprovalRequest {
  return {
    requestId: id, runId: 'run', operationId: id, inputDigest: approvalInputDigest(input), cwd,
    tool: 'Bash', preview: input.command, signal: new AbortController().signal,
  }
}

function controlledHost(broker: ApprovalBroker) {
  const calls: ApprovalRequest[] = []
  const resolvers: ((decision: ApprovalDecision) => void)[] = []
  broker.attachHost({ request: (req) => {
    calls.push(req)
    return new Promise<ApprovalDecision>((resolve) => { resolvers.push(resolve) })
  } })
  const decide = (index: number, overrides: Partial<ApprovalDecision> = {}) => {
    const req = calls[index]
    resolvers[index]({ requestId: req.requestId, inputDigest: req.inputDigest, cwd: req.cwd, action: 'allow', scope: 'once', status: 'decided', ...overrides })
  }
  return { calls, decide }
}

describe('approval input digest', () => {
  it('binds all JSON values with stable object ordering and ordered arrays', () => {
    expect(approvalInputDigest({ b: [1, { x: 'a' }], a: true })).toBe(approvalInputDigest({ a: true, b: [1, { x: 'a' }] }))
    expect(approvalInputDigest({ command: 'npm test', options: { cwd: 'a' } })).not.toBe(approvalInputDigest({ command: 'npm test', options: { cwd: 'b' } }))
    expect(approvalInputDigest([1, 2])).not.toBe(approvalInputDigest([2, 1]))
    expect(() => approvalInputDigest({ command: undefined })).toThrow()
  })
})

describe('approval broker', () => {
  it('presents three concurrent requests FIFO and settles each exactly once', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const settled: string[] = []
    const promises = ['one', 'two', 'three'].map((id) => broker.request(request(id)).then((decision) => { settled.push(id); return decision }))
    expect(host.calls.map((req) => req.requestId)).toEqual(['one'])
    expect(broker.pendingSnapshot().map((req) => req.requestId)).toEqual(['one', 'two', 'three'])
    host.decide(0)
    await vi.waitFor(() => expect(host.calls).toHaveLength(2))
    host.decide(0, { action: 'deny' })
    host.decide(1, { action: 'deny' })
    await vi.waitFor(() => expect(host.calls).toHaveLength(3))
    host.decide(2)
    expect((await Promise.all(promises)).map((decision) => decision.action)).toEqual(['allow', 'deny', 'allow'])
    expect(settled).toEqual(['one', 'two', 'three'])
    expect(broker.pendingSnapshot()).toEqual([])
  })

  it.each(['requestId', 'inputDigest', 'cwd'] as const)('rejects a decision with stale %s', async (field) => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const pending = broker.request(request('one'))
    host.decide(0, { [field]: 'different' })
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'stale' })
  })

  it.each(['inputDigest', 'cwd'] as const)('rejects approval when the submitted %s changes during the wait', async (field) => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const req = request('one')
    const pending = broker.request(req)
    req[field] = 'different'
    host.decide(0)
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'stale' })
  })

  it('limits a session grant to the exact tool, complete input and directory', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const first = broker.request(request('test'))
    host.decide(0, { scope: 'session' })
    await expect(first).resolves.toMatchObject({ action: 'allow', scope: 'session' })
    await expect(broker.request(request('test-again'))).resolves.toMatchObject({ action: 'allow', scope: 'session' })
    const mutations = [
      request('delete', { command: 'rm -rf .' }), request('push', { command: 'git push' }),
      request('other-cwd', { command: 'npm test' }, '/other'), request('other-input', { command: 'npm test', timeout: 999 }),
      { ...request('other-tool'), tool: 'Read' },
    ]
    for (let index = 0; index < mutations.length; index++) {
      const pending = broker.request(mutations[index])
      await vi.waitFor(() => expect(host.calls).toHaveLength(index + 2))
      host.decide(index + 1, { action: 'deny' })
      await expect(pending).resolves.toMatchObject({ action: 'deny' })
    }
  })

  it('does not reuse an operation session grant under a different reviewed policy', async () => {
    const broker = new ApprovalBroker()
    const calls: ApprovalRequest[] = []
    broker.attachHost({ request: (req) => {
      calls.push(req)
      return Promise.resolve({ requestId: req.requestId, inputDigest: req.inputDigest, cwd: req.cwd,
        action: calls.length === 1 ? 'allow' : 'deny', scope: 'session', status: 'decided' })
    } })
    const firstPolicy = approvalInputDigest({ inheritedEnvironment: true, permissions: 'cautious' })
    const secondPolicy = approvalInputDigest({ inheritedEnvironment: false, permissions: 'cautious' })
    await expect(broker.request({ ...request('one'), policyDigest: firstPolicy })).resolves.toMatchObject({ action: 'allow', scope: 'session' })
    await expect(broker.request({ ...request('two'), policyDigest: firstPolicy })).resolves.toMatchObject({ action: 'allow', scope: 'session' })
    await expect(broker.request({ ...request('three'), policyDigest: secondPolicy })).resolves.toMatchObject({ action: 'deny' })
    expect(calls).toHaveLength(2)
    expect(calls[1].policyDigest).toBe(secondPolicy)
  })

  it('rejects a decision when the submitted reviewed policy changes during the wait', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const req = { ...request('one'), policyDigest: 'policy-one' }
    const pending = broker.request(req)
    req.policyDigest = 'policy-two'
    host.decide(0, { scope: 'session' })
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'stale' })
  })

  it('keeps a no-host request visible without retroactively executing after attachment', async () => {
    const broker = new ApprovalBroker()
    const req = request('one')
    await expect(broker.request(req)).resolves.toMatchObject({ action: 'deny', status: 'needs_input' })
    expect(broker.pendingSnapshot()).toMatchObject([{ requestId: 'one', status: 'needs_input' }])
    const host = controlledHost(broker)
    expect(host.calls).toHaveLength(0)
    const retry = broker.request(req)
    host.decide(0)
    await expect(retry).resolves.toMatchObject({ action: 'allow', status: 'decided' })
    expect(broker.pendingSnapshot()).toEqual([])
  })

  it('does not reuse a session grant after the approval host disconnects', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const first = broker.request(request('one'))
    host.decide(0, { scope: 'session' })
    await expect(first).resolves.toMatchObject({ action: 'allow' })
    broker.disconnectHost()
    await expect(broker.request(request('two'))).resolves.toMatchObject({ action: 'deny', status: 'needs_input' })
  })

  it('cancels active and queued requests without accepting late session grants', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const controller = new AbortController()
    const first = broker.request({ ...request('one'), signal: controller.signal })
    const second = broker.request(request('two'))
    expect(broker.cancel('two')).toBe(true)
    controller.abort()
    await expect(first).resolves.toMatchObject({ action: 'deny', status: 'cancelled' })
    await expect(second).resolves.toMatchObject({ action: 'deny', status: 'cancelled' })
    expect(host.calls[0].signal.aborted).toBe(true)
    host.decide(0, { scope: 'session' })
    const next = broker.request(request('three'))
    await vi.waitFor(() => expect(host.calls).toHaveLength(2))
    host.decide(1, { action: 'deny' })
    await expect(next).resolves.toMatchObject({ action: 'deny' })
  })

  it('settles a disconnected host queue as needs_input and aborts the displayed request', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const pending = ['one', 'two', 'three'].map((id) => broker.request(request(id)))
    broker.disconnectHost('Terminal closed')
    expect((await Promise.all(pending)).map((decision) => [decision.action, decision.status])).toEqual([
      ['deny', 'needs_input'], ['deny', 'needs_input'], ['deny', 'needs_input'],
    ])
    expect(host.calls[0].signal.aborted).toBe(true)
    expect(broker.pendingSnapshot()).toHaveLength(3)
  })

  it('requires an explicit matching rule selection rather than deriving a tool wildcard', async () => {
    const saved: string[] = []
    const broker = new ApprovalBroker({ onRule: (rule) => { saved.push(rule) } })
    const host = controlledHost(broker)
    const invalid = broker.request({ ...request('one'), ruleSuggestion: 'Bash:npm test' })
    host.decide(0, { scope: 'rule', rule: 'Bash:*' })
    await expect(invalid).resolves.toMatchObject({ action: 'deny', status: 'stale' })
    const valid = broker.request({ ...request('two'), ruleSuggestion: 'Bash:npm test' })
    await vi.waitFor(() => expect(host.calls).toHaveLength(2))
    host.decide(1, { scope: 'rule', rule: 'Bash:npm test' })
    await expect(valid).resolves.toMatchObject({ action: 'allow', scope: 'rule', rule: 'Bash:npm test' })
    expect(saved).toEqual(['Bash:npm test'])
  })

  it('hides persistent rule selection and fails closed when no persistence adapter exists', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const pending = broker.request({ ...request('one'), ruleSuggestion: 'Bash:npm test' })
    expect(host.calls[0].ruleSuggestion).toBeUndefined()
    host.decide(0, { scope: 'rule', rule: 'Bash:npm test' })
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'needs_input' })
  })

  it('does not approve after a persistent rule callback rejects', async () => {
    const broker = new ApprovalBroker({ onRule: () => Promise.reject(new Error('Cannot save rule')) })
    const host = controlledHost(broker)
    const pending = broker.request({ ...request('one'), ruleSuggestion: 'Bash:npm test' })
    host.decide(0, { scope: 'rule', rule: 'Bash:npm test' })
    await expect(pending).resolves.toMatchObject({ action: 'deny', status: 'needs_input', feedback: expect.stringContaining('Cannot save rule') })
    expect(broker.pendingSnapshot()).toHaveLength(1)
  })

  it('does not turn a host exception into approval and preserves the request', async () => {
    const broker = new ApprovalBroker()
    broker.attachHost({ request: () => Promise.reject(new Error('Connection closed')) })
    await expect(broker.request(request('one'))).resolves.toMatchObject({ action: 'deny', status: 'needs_input', feedback: expect.stringContaining('Connection closed') })
    expect(broker.pendingSnapshot()).toMatchObject([{ requestId: 'one', status: 'needs_input' }])
    expect(broker.cancel('one')).toBe(true)
    expect(broker.pendingSnapshot()).toEqual([])
  })

  it('rejects duplicate active identities and keeps the original request pending', async () => {
    const broker = new ApprovalBroker()
    const host = controlledHost(broker)
    const first = broker.request(request('one'))
    await expect(broker.request(request('one', { command: 'git push' }))).resolves.toMatchObject({ action: 'deny', status: 'stale' })
    expect(host.calls).toHaveLength(1)
    host.decide(0)
    await expect(first).resolves.toMatchObject({ action: 'allow' })
  })
})
