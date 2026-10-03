import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, createConnection, type Server } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon, DaemonClient, resolveDaemonSocketPath } from '../../src/core/daemon.js'

let cwd: string
const daemons: Daemon[] = []
const servers = new Set<Server>()
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'daemon-lifecycle-')) })
afterEach(async () => {
  await Promise.all(daemons.splice(0).map(daemon => daemon.stop()))
  await Promise.all([...servers].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  servers.clear()
  rmSync(cwd, { recursive: true, force: true })
})

async function responder(body: Buffer, fragmented = false) {
  const path = resolveDaemonSocketPath(join(cwd, 'fixture.sock'))
  const server = createServer(socket => socket.once('data', () => {
    if (!fragmented) { socket.end(body); return }
    const split = body.indexOf(Buffer.from('中')) + 1
    socket.write(body.subarray(0, split))
    setTimeout(() => socket.end(body.subarray(split)), 10)
  }))
  servers.add(server)
  await new Promise<void>(resolve => server.listen(path, resolve))
  return new DaemonClient(path)
}

describe('daemon lifecycle and framing', () => {
  it('coalesces concurrent starts into one listening endpoint', async () => {
    const daemon = new Daemon(join(cwd, 'daemon.sock'), join(cwd, 'daemon.log'))
    daemons.push(daemon)
    const first = daemon.start()
    const firstServer = (daemon as unknown as { server: Server | null }).server
    if (firstServer) servers.add(firstServer)
    expect(await Promise.allSettled([first, daemon.start()])).toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }])
    expect(await new DaemonClient(join(cwd, 'daemon.sock')).ping()).toBe(true)
  })

  it('rejects a JSON null response as invalid', async () => {
    const client = await responder(Buffer.from('null\n'))
    expect(await client.send({ action: 'ping' })).toMatchObject({ ok: false, error: 'Invalid daemon response' })
  })

  it('decodes response UTF8 split across data events', async () => {
    const client = await responder(Buffer.from(JSON.stringify({ ok: true, data: '中文 🧩' }) + '\n'), true)
    expect(await client.send({ action: 'ping' })).toEqual({ ok: true, data: '中文 🧩' })
  })

  it('applies the request byte limit to each frame in a combined chunk', async () => {
    const path = join(cwd, 'daemon.sock')
    const daemon = new Daemon(path, join(cwd, 'daemon.log'), { maxFrameBytes: 24 })
    daemons.push(daemon)
    await daemon.start()
    const lines = await new Promise<unknown[]>((resolve, reject) => {
      const socket = createConnection(resolveDaemonSocketPath(path))
      let buffer = ''
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('Fixture response timeout')) }, 1000)
      socket.on('connect', () => socket.write('{"action":"ping"}\n{"action":"ping"}\n'))
      socket.on('error', reject)
      socket.on('data', data => {
        buffer += data.toString()
        const rows = buffer.trim().split('\n').map(line => JSON.parse(line) as unknown)
        if (rows.length === 2 || buffer.includes('limit')) { clearTimeout(timeout); socket.destroy(); resolve(rows) }
      })
    })
    expect(lines).toEqual([{ ok: true, data: 'pong' }, { ok: true, data: 'pong' }])
  })
})
