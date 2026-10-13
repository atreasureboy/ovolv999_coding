import { expect, it, vi } from 'vitest'
import { ApprovalBroker, type ApprovalEvent, type ApprovalRequest } from '../../src/core/approvalBroker.js'

const request = (): ApprovalRequest => ({ requestId: 'request', runId: 'run', operationId: 'operation', cwd: process.cwd(), tool: 'Write', inputDigest: 'digest', preview: 'write', signal: new AbortController().signal })

it('publishes request and resolution without signals and releases subscriptions', async () => {
  const broker = new ApprovalBroker()
  broker.attachHost({ request: pending => Promise.resolve({ requestId: pending.requestId, inputDigest: pending.inputDigest, cwd: pending.cwd, action: 'allow', scope: 'once', status: 'decided' }) })
  const events: ApprovalEvent[] = []
  const unsubscribe = broker.subscribe(event => { events.push(event) })
  expect((await broker.request(request())).action).toBe('allow')
  expect(events.map(event => event.type)).toEqual(['requested', 'resolved'])
  expect(events.every(event => !('signal' in event.request))).toBe(true)
  unsubscribe()
  await broker.request({ ...request(), requestId: 'next' })
  expect(events).toHaveLength(2)
})

it('refuses dispatch when durable request publication fails', async () => {
  const broker = new ApprovalBroker()
  const host = vi.fn()
  broker.attachHost({ request: host })
  broker.subscribe(() => { throw new Error('durable approval write refused') })
  await expect(Promise.resolve().then(() => broker.request(request()))).rejects.toThrow('durable approval write refused')
  expect(host).not.toHaveBeenCalled()
  expect(broker.pendingSnapshot()).toEqual([])
})

it('does not grant a session approval if durable resolution publication fails', async () => {
  const broker = new ApprovalBroker()
  const host = vi.fn((pending: ApprovalRequest) => Promise.resolve({ requestId: pending.requestId, inputDigest: pending.inputDigest, cwd: pending.cwd, action: 'allow' as const, scope: 'session' as const, status: 'decided' as const }))
  broker.attachHost({ request: host })
  const unsubscribe = broker.subscribe(event => { if (event.type === 'resolved') throw new Error('resolution failed') })
  expect(await broker.request(request())).toMatchObject({ action: 'deny', status: 'needs_input' })
  unsubscribe()
  expect((await broker.request({ ...request(), requestId: 'next' })).action).toBe('allow')
  expect(host).toHaveBeenCalledTimes(2)
})
