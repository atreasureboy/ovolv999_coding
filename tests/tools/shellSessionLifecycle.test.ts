import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, connect, type Socket } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ToolContext } from '../../src/core/types.js'
import { ShellSessionTool } from '../../src/tools/shellSession.js'

let cwd: string
let port: number
let socket: Socket | undefined
let context: ToolContext
const tool = new ShellSessionTool()

beforeEach(async () => {
  cwd = mkdtempSync(join(tmpdir(), 'shell-lifecycle-'))
  context = { cwd, permissionMode: 'auto' }
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
  await new Promise<void>(resolve => server.close(() => resolve()))
})

afterEach(async () => {
  socket?.destroy()
  await tool.execute({ action: 'kill', port }, context)
  rmSync(cwd, { recursive: true, force: true })
  socket = undefined
})

async function connected(): Promise<Socket> {
  expect((await tool.execute({ action: 'listen', port, log_dir: cwd }, context)).isError).toBe(false)
  socket = connect(port, '127.0.0.1')
  await new Promise<void>(resolve => socket!.once('connect', resolve))
  return socket
}

describe('ShellSession output completion', () => {
  it('keeps waiting through quiet output until the completion marker arrives', async () => {
    const client = await connected()
    const timers: ReturnType<typeof setTimeout>[] = []
    client.once('data', data => {
      const marker = data.toString().match(/__EOC_[A-Za-z0-9_-]+__/)![0]
      client.write('early output\n')
      timers.push(setTimeout(() => client.write(`late output\n${marker}\n`), 600))
    })
    try {
      const result = await tool.execute({ action: 'exec', port, command: 'long-command', timeout: 2000 }, context)
      expect(result.isError).toBe(false)
      expect(result.content).toContain('late output')
    } finally { for (const timer of timers) clearTimeout(timer) }
  })

  it('reports an expired wait without claiming command success', async () => {
    await connected()
    const result = await tool.execute({ action: 'exec', port, command: 'long-command', timeout: 30 }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/timed out/i)
  })

  it('cancels a pending output wait when the parent aborts', async () => {
    const client = await connected()
    const abort = new AbortController()
    context.signal = abort.signal
    client.once('data', () => abort.abort())
    const result = await tool.execute({ action: 'exec', port, command: 'long-command', timeout: 100 }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/cancelled/i)
  })

  it('does not leave a listening socket behind after kill returns', async () => {
    await connected()
    await tool.execute({ action: 'kill', port }, context)
    const replacement = createServer()
    try {
      await new Promise<void>((resolve, reject) => { replacement.once('error', reject); replacement.listen(port, '127.0.0.1', resolve) })
    } finally { await new Promise<void>(resolve => replacement.close(() => resolve())) }
  })
})
