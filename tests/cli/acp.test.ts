import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { AgentEvent } from '../../src/core/agentEvents.js'
import { AgentEventStore } from '../../src/core/agentEventStore.js'
import { readSessionSnapshot } from '../../src/core/sessionManager.js'
import type { JsonRpcMessage, JsonRpcResponse } from '../../src/integrations/acp.js'

const fixtures: Array<{ base: string; server: Server }> = []
const children = new Set<ChildProcessWithoutNullStreams>()
afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = new Promise<void>(resolve => child.once('close', () => resolve()))
      child.kill('SIGTERM')
      await closed
    }
  }
  children.clear()
  for (const { base, server } of fixtures.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  }
})

async function setup(mode: 'text' | 'coding' | 'stall' = 'text', output = 'ready') {
  const base = mkdtempSync(join(tmpdir(), 'ovo-acp-cli-'))
  const cwd = join(base, 'workspace')
  mkdirSync(cwd)
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ model: 'fixture', enabledModules: [], permissionMode: 'auto' }))
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      const data = JSON.parse(body) as typeof requests[number]
      requests.push(data)
      const count = data.messages.filter(message => message.role === 'tool').length
      const tool = mode === 'coding' && count < 2 ? { name: count ? 'Edit' : 'Read', input: count ? { file_path: 'source.txt', old_string: 'before', new_string: 'after' } : { file_path: 'source.txt' } } : undefined
      const delta = tool ? { tool_calls: [{ index: 0, id: 'acp-call-' + count, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.input) } }] } : { content: mode === 'stall' ? 'partial 中文' : output }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: mode === 'stall' ? null : tool ? 'tool_calls' : 'stop' }] })}\n\n`)
      if (mode !== 'stall') response.end('data: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address unavailable')
  fixtures.push({ base, server })
  const launch = (extra: string[] = []) => {
    const child = spawn(process.execPath, ['--import', 'tsx', resolve('bin/ovogogogo.ts'), 'acp', '--cwd', cwd, ...extra], { cwd: resolve('.'), windowsHide: true, env: { ...process.env, USERPROFILE: base, HOME: base, OVOGO_STATE_DIR: join(base, 'runtime'), OPENAI_API_KEY: 'fixture', OPENAI_BASE_URL: `http://127.0.0.1:${address.port}/v1`, OVOGO_MODEL: 'fixture' }, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    const messages: JsonRpcMessage[] = []
    const waiting = new Set<() => void>()
    let stderr = '', remainder = '', failure: Error | undefined, closed = false
    const changed = () => { for (const waiter of [...waiting]) waiter() }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (text: string) => { stderr += text })
    child.stdout.on('data', (text: string) => {
      remainder += text
      for (;;) {
        const newline = remainder.indexOf('\n')
        if (newline < 0) break
        const line = remainder.slice(0, newline)
        remainder = remainder.slice(newline + 1)
        try { messages.push(JSON.parse(line) as JsonRpcMessage) } catch { failure = new Error('ACP stdout is not JSON-RPC: ' + line) }
      }
      changed()
    })
    child.on('error', error => { failure = error; changed() })
    const exit = new Promise<number | null>(resolve => child.once('close', code => { closed = true; children.delete(child); changed(); resolve(code) }))
    const wait = (predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage> => new Promise((resolveWait, reject) => {
      const check = () => {
        const value = messages.find(predicate)
        if (value || failure || closed) {
          waiting.delete(check)
          if (value) resolveWait(value)
          else reject(failure ?? new Error('ACP exited without a response: ' + stderr))
        }
      }
      waiting.add(check)
      check()
    })
    const send = (id: number, method: string, params?: Record<string, unknown>) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n') }
    const response = (id: number) => wait(message => 'id' in message && message.id === id) as Promise<JsonRpcResponse>
    const events = () => messages.flatMap(message => 'method' in message && message.method === 'agent/event' ? [message.params!.event as AgentEvent] : [])
    return { child, messages, send, response, wait, events, exit, stderr: () => stderr }
  }
  return { cwd, requests, launch }
}

it('runs real ACP coding turns with persisted events and no direct filesystem bypass', async () => {
  const { cwd, launch } = await setup('coding')
  writeFileSync(join(cwd, 'source.txt'), 'before')
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }))
  writeFileSync(join(cwd, 'verify.cjs'), "const fs=require('fs');if(fs.readFileSync('source.txt','utf8')!=='after')process.exit(9);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/verified.txt','yes')")
  const rpc = launch()
  rpc.send(0, 'initialize')
  expect((await rpc.response(0)).result).toMatchObject({ capabilities: { streaming: true, tools: true, interrupts: true, multiModal: false, worktrees: false } })
  rpc.send(1, 'file/write', { path: 'forbidden.txt', content: 'unsafe' })
  expect((await rpc.response(1)).error?.code).toBe(-32601)
  rpc.send(2, 'message', { text: 'edit source' })
  expect((await rpc.response(2)).result).toMatchObject({ text: 'ready', status: 'completed', threadId: expect.any(String), turnId: expect.any(String), done: true })
  const events = rpc.events()
  expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1))
  expect(events.at(-1)).toMatchObject({ type: 'turn.finished', status: 'completed' })
  expect(events.flatMap(event => event.type === 'item.started' && event.kind === 'tool' ? [event.toolCallId] : [])).toEqual(['acp-call-0', 'acp-call-1'])
  expect(readFileSync(join(cwd, 'source.txt'), 'utf8')).toBe('after')
  expect(readFileSync(join(cwd, 'dist/verified.txt'), 'utf8')).toBe('yes')
  expect(existsSync(join(cwd, 'forbidden.txt'))).toBe(false)
  rpc.send(3, 'shutdown')
  expect(await rpc.exit, rpc.stderr()).toBe(0)
})

it('keeps canonical history across messages and resumed ACP processes', async () => {
  const { cwd, launch, requests } = await setup()
  const first = launch()
  first.send(0, 'initialize'); await first.response(0)
  first.send(1, 'message', { text: 'remember the first message' }); await first.response(1)
  first.send(2, 'message', { text: 'continue this conversation' }); await first.response(2)
  first.send(3, 'shutdown'); expect(await first.exit, first.stderr()).toBe(0)
  const session = readdirSync(join(cwd, 'sessions')).find(name => name.startsWith('session_'))!
  const second = launch(['--resume', session])
  second.send(0, 'initialize'); await second.response(0)
  second.send(1, 'message', { text: 'continue after restart' }); await second.response(1)
  second.send(2, 'shutdown'); expect(await second.exit, second.stderr()).toBe(0)
  expect(requests.at(-1)!.messages.filter(message => message.role === 'user').map(message => message.content)).toEqual(['remember the first message', 'continue this conversation', 'continue after restart'])
  expect(second.events()[0].sequence).toBe(first.events().at(-1)!.sequence + 1)
  expect(second.events()[0].threadId).toBe(first.events()[0].threadId)
})

it('fences cancellation by the active turn and preserves streamed partial text', async () => {
  const { launch } = await setup('stall')
  const rpc = launch()
  rpc.send(0, 'initialize'); await rpc.response(0)
  rpc.send(1, 'message', { text: 'keep working' })
  await rpc.wait(message => 'method' in message && message.method === 'agent/event' && (message.params?.event as AgentEvent).type === 'item.delta' && String((message.params?.event as AgentEvent & { itemId?: string }).itemId).startsWith('assistant:'))
  const turnId = rpc.events()[0].turnId
  rpc.send(2, 'interrupt', { expectedTurnId: 'stale-turn' })
  expect((await rpc.response(2)).result).toEqual({ interrupted: false })
  rpc.send(3, 'interrupt', { expectedTurnId: turnId })
  expect((await rpc.response(3)).result).toEqual({ interrupted: true })
  expect((await rpc.response(1)).result).toMatchObject({ status: 'cancelled', turnId })
  expect(rpc.events().flatMap(event => event.type === 'item.delta' && event.itemId.startsWith('assistant:') ? [event.text] : []).join('')).toBe('partial 中文')
  expect(rpc.events().at(-1)).toMatchObject({ type: 'turn.finished', status: 'cancelled' })
  rpc.send(4, 'shutdown'); expect(await rpc.exit, rpc.stderr()).toBe(0)
})

it('rejects unsupported image input before dispatching a model request', async () => {
  const { launch, requests } = await setup()
  const rpc = launch()
  rpc.send(0, 'initialize'); await rpc.response(0)
  rpc.send(1, 'message', { text: 'inspect', images: ['data:image/png;base64,YQ=='] })
  expect((await rpc.response(1)).error?.message).toMatch(/image|vision/i)
  expect(requests).toHaveLength(0)
  rpc.send(2, 'shutdown'); expect(await rpc.exit, rpc.stderr()).toBe(0)
})

it('advertises and forwards validated image input for a vision-capable model', async () => {
  const { cwd, launch, requests } = await setup()
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ model: 'fixture', enabledModules: [], permissionMode: 'auto', modelSettings: { fixture: { capabilities: { vision: true } } } }))
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='
  const rpc = launch()
  rpc.send(0, 'initialize')
  expect((await rpc.response(0)).result).toMatchObject({ capabilities: { multiModal: true } })
  rpc.send(1, 'message', { text: 'inspect', images: [image] })
  expect((await rpc.response(1)).result).toMatchObject({ status: 'completed' })
  expect(requests[0].messages.find(message => message.role === 'user')?.content).toEqual([{ type: 'text', text: 'inspect' }, { type: 'image_url', image_url: { url: image } }])
  rpc.send(2, 'shutdown'); expect(await rpc.exit, rpc.stderr()).toBe(0)
})

it.each(['eof', 'shutdown'])('settles active execution and releases session ownership after %s', async mode => {
  const { cwd, launch } = await setup('stall')
  const rpc = launch()
  rpc.send(0, 'initialize'); await rpc.response(0)
  rpc.send(1, 'message', { text: 'keep working' })
  await rpc.wait(message => 'method' in message && message.method === 'agent/event' && (message.params?.event as AgentEvent).type === 'item.delta' && String((message.params?.event as AgentEvent & { itemId?: string }).itemId).startsWith('assistant:'))
  if (mode === 'eof') rpc.child.stdin.end()
  else rpc.send(2, 'shutdown')
  expect(await rpc.exit, rpc.stderr()).toBe(0)
  const sessionDir = join(cwd, 'sessions', readdirSync(join(cwd, 'sessions')).find(name => name.startsWith('session_'))!)
  const envelope = readSessionSnapshot(sessionDir)
  expect(envelope.messages.some(message => message.role === 'assistant' && message.content === 'partial 中文'), JSON.stringify(envelope)).toBe(true)
  const events = new AgentEventStore({ sessionDir, cwd, threadId: rpc.events()[0].threadId, readOnly: true })
  try { expect(events.snapshot()).toMatchObject({ recovery: 'clean', activeTurn: null, lastTurn: { status: 'cancelled' } }) } finally { events.close() }
})

it('streams large escaped output and points to its complete persisted result', async () => {
  const output = '\u0001'.repeat(22000)
  const { cwd, launch } = await setup('text', output)
  const rpc = launch()
  rpc.send(0, 'initialize'); await rpc.response(0)
  rpc.send(1, 'message', { text: 'respond' })
  const response = await rpc.response(1)
  expect(response.result).toMatchObject({ status: 'completed', truncated: true, artifact: expect.any(String) })
  expect(rpc.events().flatMap(event => event.type === 'item.delta' && event.itemId.startsWith('assistant:') ? [event.text] : []).join('')).toBe(output)
  const sessionDir = join(cwd, 'sessions', readdirSync(join(cwd, 'sessions')).find(name => name.startsWith('session_'))!)
  expect(JSON.parse(readFileSync(join(sessionDir, (response.result as { artifact: string }).artifact), 'utf8'))).toMatchObject({ status: 'completed', output })
  rpc.send(2, 'shutdown'); expect(await rpc.exit, rpc.stderr()).toBe(0)
})
