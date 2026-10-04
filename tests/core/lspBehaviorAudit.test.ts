import type * as ChildProcessModule from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectServer, fileUriToPath, getDefaultLspClient, LspClient, pathToFileUri, shutdownDefaultLspClient } from '../../src/core/lspClient.js'
import { resolve } from 'node:path'
import { createProcessScope } from '../../src/core/executionBackend.js'
import { resolveExecutionPolicy } from '../../src/core/executionPolicy.js'

const transport = vi.hoisted(() => ({ spawn: vi.fn(), execFileSync: vi.fn(() => { throw new Error('Not installed') }) }))
vi.mock('child_process', async importOriginal => ({ ...(await importOriginal<typeof ChildProcessModule>()), ...transport }))

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

function server() {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const stdin = new Writable({ write(chunk: Buffer, _encoding, callback) {
    const request = JSON.parse(chunk.toString().split('\r\n\r\n')[1]) as { id: number; method: string }
    if (request.method === 'initialize' || request.method === 'shutdown') {
      queueMicrotask(() => stdout.write(frame({ jsonrpc: '2.0', id: request.id, result: {} })))
    }
    callback()
  } })
  const proc = Object.assign(new EventEmitter(), { pid: 123, stdout, stderr, stdin, kill: vi.fn(() => true) })
  transport.spawn.mockImplementation(() => proc)
  return { stdout, proc }
}

const clients: LspClient[] = []
afterEach(async () => {
  clients.splice(0).forEach(client => client.kill())
  await shutdownDefaultLspClient()
  transport.spawn.mockReset()
})

function client() {
  const value = new LspClient({ rootUri: pathToFileUri(process.cwd()), command: 'fixture', timeoutMs: 500 })
  clients.push(value)
  return value
}

describe('LSP lifecycle boundaries', () => {
  it('round trips reserved URI characters without treating them as fragments', () => {
    const path = resolve('中文 folder', 'a#b%20.ts')
    const uri = pathToFileUri(path)
    expect(new URL(uri).hash).toBe('')
    expect(fileUriToPath(uri)).toBe(path)
  })

  it('keeps default clients separate for different workspaces', () => {
    expect(getDefaultLspClient(pathToFileUri('one'))).not.toBe(getDefaultLspClient(pathToFileUri('two')))
  })

  it('does not present TypeScript tsserver as a JSON-RPC language server', () => {
    expect(detectServer('typescript')).toBeNull()
  })

  it('shares one initialization when callers start concurrently', async () => {
    server()
    const value = client()
    expect(await Promise.all([value.start(), value.start()])).toEqual([true, true])
    expect(transport.spawn).toHaveBeenCalledTimes(1)
  })

  it('refuses server launch beneath an unsupported execution policy scope', async () => {
    server()
    const value = client()
    const result = await createProcessScope(undefined, resolveExecutionPolicy({ mode: 'isolated-worker' }, process.cwd())).run(() => value.start())
    expect(result).toBe(false)
    expect(transport.spawn).not.toHaveBeenCalled()
  })

  it('settles pending requests promptly when the server exits', async () => {
    const fake = server()
    const value = client()
    await value.start()
    const pending = value.workspaceSymbols('hello')
    fake.proc.emit('exit', 1)
    expect(await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('still pending'), 20))])).toEqual([])
  })

  it('closes a transport with an oversized frame', async () => {
    const fake = server()
    const value = client()
    await value.start()
    fake.stdout.write(Buffer.from('Content-Length: 999999999\r\n\r\n'))
    expect(value.isRunning()).toBe(false)
    expect(fake.proc.kill).toHaveBeenCalledOnce()
  })

  it('discards diagnostics belonging to a stopped server', async () => {
    const fake = server()
    const value = client()
    await value.start()
    fake.stdout.write(frame({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: {
      uri: 'file:///old.ts', diagnostics: [{ message: 'old failure' }],
    } }))
    expect(value.getDiagnostics()).toHaveLength(1)
    value.kill()
    expect(value.getDiagnostics()).toEqual([])
  })
})
