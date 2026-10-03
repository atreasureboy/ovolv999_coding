import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LspClient, pathToFileUri } from '../../src/core/lspClient.js'

const transport = vi.hoisted(() => ({ spawn: vi.fn() }))

vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  spawn: transport.spawn,
}))

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function server() {
  const stdout = new PassThrough()
  const requests: Array<{ id?: number; method: string }> = []
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      const request = JSON.parse(chunk.toString().split('\r\n\r\n')[1]) as {
        id?: number
        method: string
      }
      requests.push(request)
      if (request.method === 'initialize' || request.method === 'shutdown') {
        stdout.write(frame({ jsonrpc: '2.0', id: request.id, result: {} }))
      }
      callback()
    },
  })
  const process = Object.assign(new EventEmitter(), {
    pid: 123,
    stdout,
    stdin,
    kill: vi.fn(() => true),
  })
  transport.spawn.mockReturnValueOnce(process)
  return { stdout, requests, process }
}

const clients: LspClient[] = []

afterEach(() => {
  for (const client of clients.splice(0)) client.kill()
  transport.spawn.mockReset()
})

async function startClient() {
  const fake = server()
  const client = new LspClient({
    rootUri: pathToFileUri(process.cwd()),
    command: 'fixture-language-server',
    timeoutMs: 50,
  })
  clients.push(client)
  expect(await client.start()).toBe(true)
  return { client, fake }
}

function log(message: string): Buffer {
  return frame({ jsonrpc: '2.0', method: 'window/logMessage', params: { message } })
}

describe('LSP stream framing', () => {
  it('decodes UTF-8 diagnostics using the declared byte length', async () => {
    const { client, fake } = await startClient()
    const uri = pathToFileUri('中文.ts')
    fake.stdout.write(frame({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [{ message: '类型不兼容 🧩', severity: 1 }] },
    }))
    expect(client.getDiagnostics(uri)).toMatchObject([{ message: '类型不兼容 🧩' }])
  })

  it('consumes multiple frames from one chunk in order', async () => {
    const { client, fake } = await startClient()
    const messages: string[] = []
    client.on('log', message => messages.push(message))
    fake.stdout.write(Buffer.concat([log('第一条'), log('second'), log('第三条')]))
    expect(messages).toEqual(['第一条', 'second', '第三条'])
  })

  it('buffers partial headers and multibyte sequences until each frame is complete', async () => {
    const { client, fake } = await startClient()
    const messages: string[] = []
    client.on('log', message => messages.push(message))
    const packet = Buffer.concat([log('中文 🧩'), log('complete')])
    for (const byte of packet.subarray(0, packet.length - 1)) {
      fake.stdout.write(Buffer.from([byte]))
    }
    expect(messages).toEqual(['中文 🧩'])
    fake.stdout.write(packet.subarray(-1))
    expect(messages).toEqual(['中文 🧩', 'complete'])
  })

  it('discards partial frames when killed and supports a new connection', async () => {
    const { client, fake } = await startClient()
    const incomplete = log('stale')
    fake.stdout.write(incomplete.subarray(0, incomplete.length - 3))
    client.kill()
    const restarted = server()
    expect(await client.start()).toBe(true)
    const messages: string[] = []
    client.on('log', message => messages.push(message))
    restarted.stdout.write(log('fresh'))
    expect(messages).toEqual(['fresh'])
  })

  it('ignores events from a stopped server and shuts down the restarted server', async () => {
    const { client, fake } = await startClient()
    await client.stop()
    const restarted = server()
    expect(await client.start()).toBe(true)
    const messages: string[] = []
    client.on('log', message => messages.push(message))
    fake.stdout.write(log('stale'))
    fake.process.emit('exit', 0)
    expect(client.isRunning()).toBe(true)
    restarted.stdout.write(log('fresh'))
    expect(messages).toEqual(['fresh'])
    await client.stop()
    expect(restarted.requests.map(request => request.method)).toContain('shutdown')
    expect(restarted.process.kill).toHaveBeenCalledOnce()
  })
})
