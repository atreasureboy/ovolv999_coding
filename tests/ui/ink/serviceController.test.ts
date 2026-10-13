import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { AgentEventStore } from '../../../src/core/agentEventStore.js'
import { readSessionSnapshot, saveSession } from '../../../src/core/sessionManager.js'
import { createInkReplController } from '../../../src/ui/ink/replController.js'
import { InkRenderer } from '../../../src/ui/ink/inkRenderer.js'
import type { Renderer } from '../../../src/ui/renderer.js'
import { UIStore } from '../../../src/ui/ink/store.js'
import '../../../src/commands/builtin.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

function answer(res: ServerResponse, text: string) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }] })}\n\n`)
  res.end('data: [DONE]\n\n')
}

async function fixture(handler?: (res: ServerResponse, count: number) => void, onUserPromptSubmit?: (prompt: string, signal?: AbortSignal) => Promise<unknown>) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-ink-service-'))
  const cwd = join(base, 'workspace'), sessionDir = join(base, 'session')
  mkdirSync(cwd)
  mkdirSync(sessionDir)
  vi.stubEnv('OVOGO_STATE_DIR', join(base, 'runtime'))
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      if (handler) handler(res, requests.length)
      else answer(res, 'durable reply')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing local fixture address')
  const store = new UIStore()
  const renderer = new InkRenderer(store)
  const engine = new ExecutionEngine({ cwd, model: 'fixture', apiKey: 'local', baseURL: `http://127.0.0.1:${address.port}/v1`, enabledModules: [], maxIterations: 3, permissionMode: 'auto', agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['Read'] } }, renderer)
  const controller = createInkReplController({ engine, store, inkRenderer: renderer as unknown as Renderer, cwd, sessionDir, skills: [], onUserPromptSubmit, onExit() {} })
  cleanups.push(async () => {
    await controller.release()
    await engine.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    rmSync(base, { recursive: true, force: true })
  })
  return { controller, engine, store, requests, cwd, sessionDir }
}

it('runs Ink through durable events with one visible reply and one canonical transcript', async () => {
  const { controller, store, sessionDir, cwd } = await fixture()
  const completed = await controller.runTurn('question')
  expect(completed.status).toBe('completed')
  const history = readSessionSnapshot(sessionDir)
  expect(history.messages).toEqual(completed.newHistory)
  const events = new AgentEventStore({ cwd, sessionDir, threadId: history.sessionId, readOnly: true })
  try {
    expect(events.snapshot().lastTurn?.status).toBe('completed')
    expect(events.read(0).filter(event => event.type === 'item.completed' && event.kind === 'message')).toHaveLength(2)
  } finally { events.close() }
  expect(store.getState().messages.filter(message => message.type === 'assistant')).toMatchObject([{ text: 'durable reply' }])
  expect(store.getState().messages.filter(message => message.type === 'user')).toMatchObject([{ text: 'question' }])
})

it('fails closed before a model request when session storage is not writable', async () => {
  const { controller, requests, sessionDir, store } = await fixture()
  writeFileSync(join(sessionDir, 'agent-events'), 'occupied')
  const result = await controller.runTurn('question')
  expect(result.status).toBe('failed')
  expect(requests).toHaveLength(0)
  expect(store.getState().messages.some(message => message.type === 'error')).toBe(true)
})

it('keeps UI busy during a rejected overlap and interrupts the current durable turn', async () => {
  let held: ServerResponse | undefined
  const { controller, store, requests, sessionDir, cwd } = await fixture(res => {
    held = res
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial 🙂' } }] })}\n\n`)
  })
  const first = controller.runTurn('first')
  await vi.waitFor(() => expect(held).toBeDefined())
  await vi.waitFor(() => expect(store.getState().streamingText).toBe('partial 🙂'))
  const overlap = await controller.runTurn('second')
  expect(overlap.status).toBe('failed')
  expect(store.getState().running).toBe(true)
  await (controller as typeof controller & { interrupt: () => Promise<void> }).interrupt()
  await first
  expect(requests).toHaveLength(1)
  const history = readSessionSnapshot(sessionDir)
  const events = new AgentEventStore({ cwd, sessionDir, threadId: history.sessionId, readOnly: true })
  try { expect(events.snapshot().lastTurn?.status).toBe('cancelled') } finally { events.close() }
  expect(store.getState().running).toBe(false)
  expect(store.getState().messages.filter(message => message.type === 'assistant')).toMatchObject([{ text: 'partial 🙂' }])
})

it('compacts the model window without replacing saved canonical tool output', async () => {
  const { controller, sessionDir } = await fixture()
  const messages = Array.from({ length: 8 }, (_, index) => [
    { role: 'user' as const, content: `question ${index}` },
    { role: 'assistant' as const, content: '', tool_calls: [{ id: `read${index}`, type: 'function' as const, function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool' as const, name: 'Read', content: 'saved output '.repeat(1000), tool_call_id: `read${index}` },
    { role: 'assistant' as const, content: `answer ${index}` },
  ]).flat()
  saveSession(sessionDir, messages)
  await controller.dispatchSlash('/compact')
  expect(readSessionSnapshot(sessionDir).messages).toEqual(messages)
  expect(controller.getHistory()).toEqual(messages)
  expect(readFileSync(join(sessionDir, 'agent-model-window.json'), 'utf8').length).toBeLessThan(JSON.stringify(messages).length)
})

it('keeps recovery and exit commands usable after session initialization fails', async () => {
  const { controller, requests, sessionDir, store } = await fixture()
  saveSession(sessionDir, [{ role: 'user', content: 'last saved question' }])
  const evidence = join(sessionDir, 'agent-events')
  writeFileSync(evidence, 'preserve original evidence')
  expect((await controller.runTurn('blocked')).status).toBe('failed')
  await expect(controller.dispatchSlash('/history')).resolves.toBe(true)
  await expect(controller.dispatchSlash('/recover --fork')).resolves.toBe(true)
  expect(store.getState().messages.at(-1)).toMatchObject({ type: 'info', text: expect.stringContaining('Created a recovery session') })
  expect((await controller.runTurn('fresh instruction')).status).toBe('completed')
  expect(requests).toHaveLength(1)
  expect(controller.getHistory()).toHaveLength(3)
  expect(readFileSync(evidence, 'utf8')).toBe('preserve original evidence')
})

it.each(['interrupt', 'release'] as const)('cancels a pending Ink prompt hook on %s without a late model request', async action => {
  let release!: () => void
  const hook = new Promise<void>(resolve => { release = resolve })
  let signal: AbortSignal | undefined
  const { controller, requests, store } = await fixture(undefined, (_prompt, cancellation) => {
    signal = cancellation
    if (action === 'release') signal!.addEventListener('abort', () => { setTimeout(release, 20) }, { once: true })
    return hook
  })
  const turn = controller.runTurn('cancel before the model')
  try {
    await vi.waitFor(() => expect(signal).toBeDefined())
    await controller[action]()
    expect((await turn).status).toBe('cancelled')
    expect(signal!.aborted).toBe(true)
    expect(store.getState().running).toBe(false)
    expect(requests).toHaveLength(0)
  } finally { release() }
  await hook
  await Promise.resolve()
  expect(requests).toHaveLength(0)
})
