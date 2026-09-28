import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { ACPServer } from '../src/integrations/acp.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('requires explicit file handlers and never writes through a default adapter', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'acp-boundary-')); dirs.push(cwd)
  writeFileSync(join(cwd, 'user.txt'), 'original')
  const output: string[] = []
  const server = new ACPServer({}, { cwd, write: value => output.push(value) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'file/write', params: { path: 'user.txt', content: 'unsafe' } })
  expect(readFileSync(join(cwd, 'user.txt'), 'utf8')).toBe('original')
  expect(JSON.parse(output.at(-1)!).error.code).toBe(-32601)
  expect(server.getCapabilities()).toMatchObject({ tools: false, streaming: false, worktrees: false, interrupts: false })
})
it('requires initialization and valid parameters before custom file side effects', async () => {
  const write = vi.fn()
  const server = new ACPServer({ onFileWrite: write }, { cwd: process.cwd(), write: () => {} })
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'file/write', params: { path: 'x', content: 'unsafe' } })
  expect(write).not.toHaveBeenCalled()
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'file/write', params: { path: 'x', content: { unsafe: true } } })
  expect(write).not.toHaveBeenCalled()
})
it('rejects overlapping tasks instead of reentering an execution owner', async () => {
  let release!: (value: string) => void
  const calls = vi.fn(() => new Promise<string>(resolve => { release = resolve }))
  const output: string[] = []
  const server = new ACPServer({ onMessage: calls }, { cwd: process.cwd(), write: value => output.push(value) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  const first = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'one' } })
  await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'message', params: { text: 'two' } })
  expect(calls).toHaveBeenCalledTimes(1)
  expect(JSON.parse(output.at(-1)!).error.message).toMatch(/busy/i)
  release('done'); await first
})
it('closes oversized unterminated input before dispatch', () => {
  const input = new PassThrough()
  const server = new ACPServer({}, { cwd: process.cwd(), maxMessageBytes: 1024, write: () => {} })
  const failed = vi.fn(); server.on('protocolError', failed)
  server.start(input)
  input.write('x'.repeat(2048))
  expect(failed).toHaveBeenCalled()
  expect(input.listenerCount('data')).toBe(0)
  input.destroy()
})
