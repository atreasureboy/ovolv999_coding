import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const fixtures: Array<{ base: string; server: Server; child: ChildProcess }> = []
const output = 'backpressure text '.repeat(100_000)

afterEach(async () => {
  for (const { base, server, child } of fixtures.splice(0)) {
    child.stdout?.resume()
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

async function setup(mode = 'pipe', keepOpen = false) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-exec-output-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  const server = createServer((request, response) => {
    request.resume()
    request.on('end', () => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      for (let offset = 0; offset < output.length; offset += 32_000) response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: output.slice(offset, offset + 32_000) }, finish_reason: null }] })}\n\n`)
      if (!keepOpen) response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`)
    })
  })
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('tests/fixtures/exec-output.mjs'), cwd, `http://127.0.0.1:${address.port}/v1`, mode], {
    cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, USERPROFILE: base, HOME: base, OVOGO_STATE_DIR: join(base, 'state') },
  })
  fixtures.push({ base, server, child })
  const messages: Array<Record<string, unknown>> = []
  child.on('message', message => messages.push(message as Record<string, unknown>))
  let stderr = ''
  child.stderr!.on('data', chunk => { stderr += String(chunk) })
  child.stdin!.end()
  const message = async (type: string) => {
    await expect.poll(() => messages.find(value => value.type === type), { timeout: 5000 }).toBeDefined().catch(error => { throw new Error(`Missing ${type}: ${stderr}; messages=${JSON.stringify(messages)}; exit=${child.exitCode}`, { cause: error }) })
    return messages.find(value => value.type === type)!
  }
  return { child, messages, message, stderr: () => stderr }
}

function events(sessionDir: string): Array<Record<string, unknown>> {
  const directory = join(sessionDir, 'agent-events')
  return readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort().flatMap(name => readFileSync(join(directory, name), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>))
}

function terminal(sessionDir: string): Record<string, unknown> | undefined {
  return events(sessionDir).find(event => event.type === 'turn.finished')
}

it.each(['SIGINT', 'SIGTERM', 'SIGHUP', 'output error'])('settles a real stopped stdout pipe after %s delivered through the child control channel', async signal => {
  const { child, message, messages, stderr } = await setup()
  const ready = await message('ready')
  await expect.poll(() => terminal(ready.sessionDir as string), { timeout: 5000 }).toMatchObject({ status: 'completed' })
  expect(messages.some(value => value.type === 'completed')).toBe(false)
  if (signal === 'output error') child.stdout!.destroy()
  else { child.send({ type: 'signal', signal }); await message('delivery') }
  const completed = await message('completed')
  expect(completed).toMatchObject({ exitCode: 1, signalListeners: [0, 0, 0], outputErrorListeners: 0,
    execution: { activeProcesses: 0 }, managed: { activeProcesses: 0, contained: 0, observedOnly: 0, unknown: 0 },
    snapshot: { activeTurn: null, recovery: 'clean', lastTurn: { status: 'completed' } } })
  await expect.poll(() => child.exitCode, { timeout: 2000 }).toBe(1)
  expect(stderr()).toContain('Event output stopped:')
  expect(stderr()).not.toMatch(/Unhandled|uncaught/i)
}, 15000)

it('consumes a late write callback after cancelling an output wait', async () => {
  const { child, message, stderr } = await setup('callback')
  await message('blocked')
  child.send({ type: 'signal', signal: 'SIGTERM' })
  expect(await message('completed')).toMatchObject({ exitCode: 1, signalListeners: [0, 0, 0], outputErrorListeners: 0 })
  await expect.poll(() => child.exitCode, { timeout: 2000 }).toBe(1)
  expect(stderr()).not.toMatch(/Unhandled|uncaught/i)
}, 15000)

it('preserves all JSONL events when a stopped consumer resumes without termination', async () => {
  const { child, message, messages, stderr } = await setup()
  const ready = await message('ready')
  await expect.poll(() => terminal(ready.sessionDir as string), { timeout: 5000 }).toMatchObject({ status: 'completed' })
  await new Promise(resolveDelay => setTimeout(resolveDelay, 1500))
  expect(messages.some(value => value.type === 'completed')).toBe(false)
  expect(child.exitCode).toBeNull()
  const chunks: Buffer[] = []
  child.stdout!.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const closed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()))
  expect(await message('completed')).toMatchObject({ exitCode: 0, signalListeners: [0, 0, 0], outputErrorListeners: 0 })
  await closed
  const events = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'completed' })
  expect(events.filter(event => event.type === 'item.delta' && String(event.itemId).startsWith('assistant:')).map(event => event.text).join('')).toBe(output)
  expect(stderr()).toBe('')
}, 15000)

it.each([false, true])('persists interruption of an active model with a draining consumer=%s', async draining => {
  const { child, message, stderr } = await setup('pipe', true)
  const chunks: Buffer[] = []
  if (draining) child.stdout!.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const ready = await message('ready')
  await expect.poll(() => events(ready.sessionDir as string).filter(event => event.type === 'item.delta').length, { timeout: 5000 }).toBeGreaterThan(12)
  expect(terminal(ready.sessionDir as string)).toBeUndefined()
  child.send({ type: 'signal', signal: 'SIGTERM' })
  const completed = await message('completed')
  expect(completed).toMatchObject({ exitCode: draining ? 130 : 1, signalListeners: [0, 0, 0], outputErrorListeners: 0,
    snapshot: { activeTurn: null, lastTurn: { status: 'cancelled' } } })
  await expect.poll(() => child.exitCode, { timeout: 2000 }).toBe(draining ? 130 : 1)
  expect(terminal(ready.sessionDir as string)).toMatchObject({ status: 'cancelled' })
  if (draining) {
    const outputEvents = Buffer.concat(chunks).toString('utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
    expect(outputEvents.at(-1)).toMatchObject({ type: 'turn.finished', status: 'cancelled' })
    expect(stderr()).toBe('')
  }
}, 15000)
