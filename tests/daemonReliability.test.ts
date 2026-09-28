import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Socket } from 'net'
import { Daemon, DaemonClient, resolveDaemonSocketPath } from '../src/core/daemon.js'

let home: string
let daemon: Daemon
let endpoint: string
const clients: Socket[] = []

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'ovogo-daemon-bounds-'))
  endpoint = resolveDaemonSocketPath(join(home, 'control.sock'))
  daemon = new Daemon(endpoint, join(home, 'daemon.log'), { drainTimeoutMs: 50, maxFrameBytes: 1024, maxLogBytes: 512, maxWorkers: 4 })
  await daemon.start()
})

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.destroy()
  await daemon.stop()
  rmSync(home, { recursive: true, force: true })
})

async function connect(): Promise<Socket> {
  const socket = new Socket({ allowHalfOpen: true })
  clients.push(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); socket.connect(endpoint) })
  return socket
}

describe('daemon bounded transport and logging', () => {
  it('drains clients by a deadline even when they keep their half of the socket open', async () => {
    await connect()
    const started = Date.now()
    await daemon.stop()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('rejects an oversized frame without retaining an unlimited partial buffer', async () => {
    const socket = await connect()
    const response = new Promise<string>(resolve => socket.once('data', data => resolve(data.toString())))
    socket.write('x'.repeat(2048))
    expect(await response).toContain('byte limit')
  })

  it('bounds registered workers and rotates logs using append files', () => {
    for (let n = 0; n < 20; n++) { const worker = daemon.addWorker(`worker-${n}`); daemon.removeWorker(worker.id) }
    expect(statSync(join(home, 'daemon.log')).size).toBeLessThanOrEqual(512)
    expect(statSync(join(home, 'daemon.log.1')).size).toBeLessThanOrEqual(512)
    expect(readFileSync(join(home, 'daemon.log'), 'utf8')).toContain('removed')
    for (let n = 0; n < 4; n++) daemon.addWorker(`held-${n}`)
    expect(() => daemon.addWorker('overflow')).toThrow(/capacity/i)
  })

  it('delivers stop acceptance before closing the request connection', async () => {
    expect(await new DaemonClient(endpoint).send({ action: 'stop' })).toMatchObject({ ok: true, data: 'stopping' })
    await daemon.stop()
  })
})
