import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runAcp } from '../../src/cli/acp.js'
import type { EngineConfig } from '../../src/core/types.js'

const fixtures: Array<{ child: ChildProcess; server: Server; base: string }> = []
const output = 'ACP pipe fixture '.repeat(100000)
it('does not retain stdout listeners when engine construction rejects invalid configuration', async () => {
  const previous = process.stdout.listeners('error')
  try {
    await expect(runAcp({ sessionDir: join(tmpdir(), 'unused-acp-session'), config: { cwd: tmpdir(), model: 'fixture', apiKey: 'fixture', maxIterations: 1, permissionMode: 'deny', effort: 'invalid' as EngineConfig['effort'] } })).rejects.toThrow(/effort/)
    expect(process.stdout.listeners('error')).toEqual(previous)
  } finally {
    for (const listener of process.stdout.listeners('error')) if (!previous.includes(listener)) process.stdout.off('error', listener as (error: Error) => void)
  }
})
afterEach(async () => {
  for (const { child, server, base } of fixtures.splice(0)) {
    child.stdout?.resume()
    child.stdin?.end()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolveExit => child.once('exit', () => resolveExit()))
      child.kill('SIGKILL')
      await exited
    }
    server.closeAllConnections()
    await new Promise<void>(resolveClose => server.close(() => resolveClose()))
    rmSync(base, { recursive: true, force: true })
  }
})

async function setup(keepOpen = true) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-acp-output-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let offset = 0; offset < output.length; offset += 32000) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output.slice(offset, offset + 32000) }, finish_reason: null }] })}\n\n`)
      if (!keepOpen) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing fixture address')
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/acp-output.mjs'), cwd, `http://127.0.0.1:${address.port}/v1`], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, HOME: base, USERPROFILE: base, OVOGO_STATE_DIR: join(base, 'state') },
  })
  fixtures.push({ child, server, base })
  const controls: Array<Record<string, unknown>> = []
  child.on('message', message => controls.push(message as Record<string, unknown>))
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  const control = async (type: string) => {
    await expect.poll(() => controls.find(message => message.type === type), { timeout: 6000 }).toBeDefined()
    return controls.find(message => message.type === type)!
  }
  const ready = await control('ready')
  const events = () => readdirSync(join(ready.sessionDir as string, 'agent-events')).filter(name => name.endsWith('.jsonl')).flatMap(name => readFileSync(join(ready.sessionDir as string, 'agent-events', name), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>))
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize' }) + '\n')
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'message', params: { text: 'Return the fixture text' } }) + '\n')
  return { child, controls, control, events, stderr: () => stderr }
}

it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'RPC interrupt', 'EOF'])('settles ACP with an unread real pipe after %s', async signal => {
  const { child, control, events, stderr } = await setup()
  await expect.poll(() => events().filter(event => event.type === 'item.delta').length, { timeout: 6000 }).toBeGreaterThan(4)
  if (signal === 'EOF') child.stdin!.end()
  else if (signal === 'RPC interrupt') child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'interrupt' }) + '\n')
  else { child.send({ signal }); await control('delivered') }
  expect(await control('completed')).toMatchObject({ signalListeners: [0, 0, 0], outputListeners: 0 })
  expect(events().find(event => event.type === 'turn.finished')).toMatchObject({ status: 'cancelled' })
  await expect.poll(() => child.exitCode, { timeout: 3000 }).toBe(0)
  expect(stderr()).not.toMatch(/Unhandled|uncaught/i)
}, 20000)

it('delivers ordered complete ACP events after a paused consumer resumes', async () => {
  const { child, control, events, stderr } = await setup(false)
  await expect.poll(() => events().filter(event => event.type === 'item.delta').length, { timeout: 6000 }).toBeGreaterThan(4)
  const chunks: Buffer[] = []
  child.stdout!.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const frames = () => Buffer.concat(chunks).toString('utf8').split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as { id?: number; method?: string; params?: { event?: Record<string, unknown> } })
  await expect.poll(() => frames().some(frame => frame.id === 1), { timeout: 6000 }).toBe(true)
  child.stdin!.end()
  expect(await control('completed')).toMatchObject({ signalListeners: [0, 0, 0], outputListeners: 0 })
  await expect.poll(() => child.exitCode, { timeout: 3000 }).toBe(0)
  const published = frames().filter(frame => frame.method === 'agent/event').map(frame => frame.params!.event!)
  expect(published.filter(event => event.type === 'item.delta' && String(event.itemId).startsWith('assistant:')).map(event => event.text).join('')).toBe(output)
  expect(published.at(-1)).toMatchObject({ type: 'turn.finished', status: 'completed' })
  expect(stderr()).toBe('')
}, 20000)
