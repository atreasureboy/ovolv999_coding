import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { McpStdioClient } from '../../src/core/mcpClient.js'

const clients: McpStdioClient[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const client of clients.splice(0)) await client.close()
})

async function client(mode: string) {
  const value = new McpStdioClient({ name: 'audit', type: 'stdio', command: [process.execPath, fileURLToPath(new URL('../fixtures/mcpAuditServer.mjs', import.meta.url)), mode] })
  clients.push(value)
  await value.connect()
  return value
}

it('retains empty discovery when the peer explicitly does not support optional methods', async () => {
  const peer = await client('unsupported')
  expect(await peer.listResources()).toEqual([])
  expect(await peer.listPrompts()).toEqual([])
})

it.each(['listResources', 'listPrompts'] as const)('surfaces a disconnected peer from %s', async method => {
  const peer = await client('disconnect')
  await expect(peer[method]()).rejects.toThrow(/exited|closed|not connected/i)
})

it.each(['listResources', 'listPrompts'] as const)('surfaces a backend error from %s', async method => {
  const peer = await client('backend-error')
  await expect(peer[method]()).rejects.toThrow('Backend unavailable')
})

it.each(['listResources', 'listPrompts', 'listTools'] as const)('rejects malformed array data from %s', async method => {
  const peer = await client('bad-array')
  await expect(peer[method]()).rejects.toThrow(/Invalid MCP/i)
})

it('rejects an incomplete matched JSON-RPC response rather than accepting empty data', async () => {
  const peer = await client('missing-result')
  await expect(peer.listTools()).rejects.toThrow(/Invalid MCP/i)
})

it('surfaces a resource listing timeout while releasing pending request capacity', async () => {
  const peer = await client('silent')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = peer.listResources().then(value => ({ value }), error => ({ error: error as Error }))
  await vi.advanceTimersByTimeAsync(30_001)
  const result = await pending
  expect(result).toHaveProperty('error')
  if ('error' in result) expect(result.error.message).toContain('timed out')
  expect(peer.getHealth().pending).toBe(0)
})

it('does not enqueue a resource read after caller cancellation', async () => {
  const peer = await client('silent')
  const controller = new AbortController()
  const reason = new Error('cancelled resource read')
  controller.abort(reason)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const operation = peer.readResource('fixture://resource', controller.signal)
  const observed = operation.then(value => ({ value }), error => ({ error: error as Error }))
  await vi.advanceTimersByTimeAsync(30_001)
  expect(await observed).toEqual({ error: reason })
  expect(peer.getHealth().pending).toBe(0)
})
