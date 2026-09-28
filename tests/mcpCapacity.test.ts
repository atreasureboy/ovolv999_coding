import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { McpStdioClient } from '../src/core/mcpClient.js'

const clients: McpStdioClient[] = []
function client(mode: string, limits: Record<string, number>) {
  const value = new McpStdioClient({ name: 'capacity', type: 'stdio', command: [process.execPath, fileURLToPath(new URL('./fixtures/mcpCapacityServer.mjs', import.meta.url)), mode], limits })
  clients.push(value)
  return value
}
afterEach(async () => { await Promise.all(clients.splice(0).map(value => value.close())) })

describe('MCP capacity boundaries', () => {
  it('rejects a real peer negotiating an unsupported protocol version', async () => {
    const value = client('unsupported-version', {})
    await expect(value.connect()).rejects.toThrow(/protocol version/i)
    expect(value.isClosed).toBe(true)
  })
  it('rejects an oversized unterminated real peer frame', async () => {
    const value = client('oversized', { maxFrameBytes: 4096 })
    await expect(value.connect()).rejects.toThrow(/frame.*limit/i)
    expect(value.isClosed).toBe(true)
  }, 5000)

  it('rejects excess inflight requests and releases capacity on cancellation', async () => {
    const value = client('hang', { maxPending: 1 })
    await value.connect()
    const controller = new AbortController()
    const first = value.listTools(controller.signal)
    const firstResult = expect(first).rejects.toThrow(/cancel/i)
    await expect(value.listTools()).rejects.toThrow(/capacity/i)
    controller.abort()
    await firstResult
    expect(value.getHealth().pending).toBe(0)
  })

  it('bounds queued bytes when a real peer does not consume stdin', async () => {
    const value = client('slow', { maxRequestBytes: 1024 * 1024, maxQueuedBytes: 2048, maxPending: 3 })
    await value.connect()
    await expect(value.callTool('large', { data: 'x'.repeat(4096) })).rejects.toThrow(/capacity|limit/i)
    expect(value.getHealth().queuedBytes).toBeLessThanOrEqual(2048)
  })
})
