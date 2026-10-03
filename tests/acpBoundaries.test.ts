import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { PassThrough } from 'node:stream'
import { ACPServer, PROTOCOL_VERSION, type JsonRpcResponse } from '../src/integrations/acp.js'

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

it('decodes UTF-8 split across chunks before processing a complete frame', async () => {
  const input = new PassThrough()
  const output: string[] = []
  const server = new ACPServer({ onMessage: text => Promise.resolve(text) }, { cwd: process.cwd(), write: value => output.push(value) })
  server.start(input)
  input.write('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n')
  const frame = Buffer.from('{"jsonrpc":"2.0","id":1,"method":"message","params":{"text":"你好"}}\n')
  const split = frame.indexOf(Buffer.from('你')) + 1
  input.write(frame.subarray(0, split))
  expect(output.map(line => JSON.parse(line) as JsonRpcResponse).filter(message => message.id === 1)).toHaveLength(0)
  input.write(frame.subarray(split))
  await Promise.resolve()
  const messages = output.map(line => JSON.parse(line) as JsonRpcResponse)
  expect(messages.find(message => message.id === 1)?.result).toEqual({ text: '你好', done: true })
  server.stop()
  input.destroy()
})

it('detaches the previous stream and discards its partial frame when restarted', () => {
  const previous = new PassThrough()
  const next = new PassThrough()
  const output: string[] = []
  const server = new ACPServer({}, { cwd: process.cwd(), write: value => output.push(value) })
  server.start(previous)
  previous.write('{"jsonrpc":"2.0",')
  server.start(next)
  previous.write('"id":99,"method":"initialize"}\n')
  next.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n')
  expect(output.map(line => JSON.parse(line) as JsonRpcResponse).map(message => message.id)).toEqual([1])
  expect(previous.listenerCount('data')).toBe(0)
  expect(previous.listenerCount('end')).toBe(0)
  server.stop()
  expect(next.listenerCount('data')).toBe(0)
  expect(next.listenerCount('end')).toBe(0)
  previous.destroy()
  next.destroy()
})

it('keeps interrupts available while a message owns execution and rejects file side effects', async () => {
  let release!: (value: string) => void
  const writes: string[] = []
  let interrupted = false
  const output: string[] = []
  const server = new ACPServer({
    onMessage: () => new Promise<string>(resolve => { release = resolve }),
    onFileWrite: path => { writes.push(path) },
    onInterrupt: () => { interrupted = true },
  }, { cwd: process.cwd(), write: value => output.push(value) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  const pending = server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'work' } })
  await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'file/write', params: { path: 'user.txt', content: 'unsafe' } })
  await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'interrupt' })
  expect(writes).toEqual([])
  expect(interrupted).toBe(true)
  expect(output.map(line => JSON.parse(line) as JsonRpcResponse).find(message => message.id === 2)?.error?.code).toBe(-32000)
  expect(output.map(line => JSON.parse(line) as JsonRpcResponse).find(message => message.id === 3)?.result).toEqual({ interrupted: true })
  release('done')
  await pending
  await server.handleMessage({ jsonrpc: '2.0', id: 4, method: 'file/write', params: { path: 'user.txt', content: 'safe' } })
  expect(writes).toEqual(['user.txt'])
})

it('leaves the server uninitialized after an unsupported protocol version', async () => {
  const output: string[] = []
  const server = new ACPServer({ onFileRead: () => 'content' }, { cwd: process.cwd(), write: value => output.push(value) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: 'unsupported' } })
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'file/read', params: { path: 'file' } })
  expect(output.map(line => JSON.parse(line) as JsonRpcResponse).map(message => message.error?.code)).toEqual([-32602, -32600])
  await server.handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION } })
  await server.handleMessage({ jsonrpc: '2.0', id: 3, method: 'file/read', params: { path: 'file' } })
  expect(JSON.parse(output.at(-1)!).result).toEqual({ path: 'file', content: 'content' })
})

it('bounds response bytes without emitting the oversized content', () => {
  const output: string[] = []
  const server = new ACPServer({}, { cwd: process.cwd(), maxMessageBytes: 128, write: value => output.push(value) })
  server.send({ jsonrpc: '2.0', id: 4, result: '密'.repeat(100) })
  expect(output).toHaveLength(1)
  expect(JSON.parse(output[0])).toEqual({ jsonrpc: '2.0', id: 4, error: { code: -32603, message: 'ACP response byte limit exceeded' } })
})
