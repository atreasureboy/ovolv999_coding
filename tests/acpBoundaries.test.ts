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

it.each(['end', 'close'])('reports transport %s once and removes input listeners', async event => {
  const input = new PassThrough()
  const server = new ACPServer({}, { cwd: process.cwd(), write: () => {} })
  const closed = vi.fn()
  server.on('close', closed)
  server.start(input)
  if (event === 'end') input.end()
  else input.destroy()
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(closed).toHaveBeenCalledOnce()
  expect(input.listenerCount('data')).toBe(0)
  expect(input.listenerCount('end')).toBe(0)
  expect(input.listenerCount('close')).toBe(0)
  expect(input.listenerCount('error')).toBe(0)
})

it('reports a failed input stream without leaking its listeners', async () => {
  const input = new PassThrough()
  const server = new ACPServer({}, { cwd: process.cwd(), write: () => {} })
  const failed = vi.fn()
  server.on('protocolError', failed)
  server.start(input)
  const error = new Error('input disconnected')
  input.destroy(error)
  await new Promise<void>(resolve => setImmediate(resolve))
  expect(failed).toHaveBeenCalledOnce()
  expect(failed).toHaveBeenCalledWith(error)
  expect(input.listenerCount('data')).toBe(0)
  expect(input.listenerCount('error')).toBe(0)
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

it('advertises streaming and images only when explicitly implemented', () => {
  const handlers = { onMessage: () => Promise.resolve('ready') }
  expect(new ACPServer(handlers, { cwd: process.cwd() }).getCapabilities()).toMatchObject({ streaming: false, multiModal: false })
  expect(new ACPServer(handlers, { cwd: process.cwd(), capabilities: { streaming: true, multiModal: true } }).getCapabilities()).toMatchObject({ streaming: true, multiModal: true })
})

it('preserves durable status and identifiers in rich message results', async () => {
  const output: string[] = []
  const result = { text: 'partial result', status: 'cancelled' as const, threadId: 'thread-1', turnId: 'turn-1', truncated: true, artifact: 'result.json' }
  const server = new ACPServer({ onMessage: () => Promise.resolve(result) }, { cwd: process.cwd(), write: line => output.push(line) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'work' } })
  const messages = output.map(line => JSON.parse(line) as JsonRpcResponse)
  expect(messages.find(message => message.id === 1)?.result).toEqual({ ...result, done: true })
})

it('awaits fenced interrupt decisions instead of acknowledging stale turns', async () => {
  const output: string[] = []
  const interrupt = vi.fn((_expectedTurnId?: string) => Promise.resolve(false))
  const server = new ACPServer({ onInterrupt: interrupt }, { cwd: process.cwd(), write: line => output.push(line) })
  await server.handleMessage({ jsonrpc: '2.0', id: 0, method: 'initialize' })
  await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'interrupt', params: { expectedTurnId: 'stale' } })
  expect(interrupt).toHaveBeenCalledWith('stale')
  expect(JSON.parse(output.at(-1)!).result).toEqual({ interrupted: false })
})

it('waits for asynchronous output and reports a failed transport', async () => {
  let fail!: (error: Error) => void
  const server = new ACPServer({}, { cwd: process.cwd(), write: () => new Promise<void>((_resolve, reject) => { fail = reject }) })
  const errors: Error[] = []
  server.on('protocolError', error => errors.push(error as Error))
  server.notify('event', { text: 'ready' })
  const flush = server.flush()
  fail(new Error('closed output'))
  await expect(flush).rejects.toThrow('closed output')
  expect(errors).toHaveLength(1)
})

it('bounds queued output when the transport is not draining', async () => {
  const complete: Array<() => void> = []
  const server = new ACPServer({}, { cwd: process.cwd(), maxMessageBytes: 128, write: () => new Promise<void>(resolve => complete.push(resolve)) })
  const errors: Error[] = []
  server.on('protocolError', error => errors.push(error as Error))
  expect(() => { for (let index = 0; index < 10; index++) server.notify('event', { text: 'x'.repeat(50) }) }).toThrow(/pending output byte limit/)
  expect(complete.length).toBeLessThan(10)
  expect(errors).toHaveLength(1)
  for (const finish of complete) finish()
  await expect(server.flush()).rejects.toThrow(/pending output byte limit/)
})

it('rejects flush promptly when another pending write never settles', async () => {
  let rejectWrite!: (error: Error) => void
  let count = 0
  const server = new ACPServer({}, { cwd: process.cwd(), write: () => new Promise<void>((_resolve, reject) => { if (!count++) rejectWrite = reject }) })
  server.notify('first')
  server.notify('second')
  const flush = server.flush().then(() => 'completed', () => 'failed')
  rejectWrite(new Error('transport closed'))
  expect(await Promise.race([flush, new Promise<string>(resolve => setTimeout(() => resolve('still waiting'), 20))])).toBe('failed')
})

it('never emits an oversized fallback error when the response identifier is too large', () => {
  const output: string[] = []
  const server = new ACPServer({}, { cwd: process.cwd(), maxMessageBytes: 128, write: text => output.push(text) })
  expect(() => server.send({ jsonrpc: '2.0', id: 'x'.repeat(128), result: 'oversized'.repeat(50) })).toThrow(/response byte limit/)
  expect(output).toEqual([])
})
