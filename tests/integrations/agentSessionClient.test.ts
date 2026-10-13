import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineObserver } from '../../src/core/engine/observer.js'
import type { AgentEvent } from '../../src/core/agentEvents.js'
import type { OpenAIMessage } from '../../src/core/types.js'
import { readSessionSnapshot, releaseSessionOwnership, saveSession } from '../../src/core/sessionManager.js'
import { AgentSessionClient } from '../../src/core/agentSessionClient.js'
import { EventLog } from '../../src/core/eventLog.js'
import { getSystemPrompt } from '../../src/prompts/system.js'
import { isWorkspaceQuarantined } from '../../src/core/runContext.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

async function fixture(options: { history?: OpenAIMessage[]; onEvent?: (event: AgentEvent) => void | Promise<void>; sessionResources?: boolean; finalizationGraceMs?: number; expectedDisposalFailure?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-session-client-'))
  const cwd = join(base, 'workspace'), sessionDir = join(cwd, 'sessions', 'session_first')
  mkdirSync(sessionDir, { recursive: true })
  vi.stubEnv('OVOGO_STATE_DIR', join(base, 'runtime'))
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let text = ''
    req.on('data', chunk => { text += String(chunk) })
    req.on('end', () => {
      requests.push(JSON.parse(text) as Record<string, unknown>)
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture address unavailable')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(base, { recursive: true, force: true }) })
  const observer = { startSpinner: vi.fn(), stopSpinner: vi.fn(), beginAssistantText: vi.fn(), streamToken: vi.fn(), endAssistantText: vi.fn(), toolStart: vi.fn(), toolResult: vi.fn(), contextWarning: vi.fn(), compactStart: vi.fn(), compactDone: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies EngineObserver
  const events: AgentEvent[] = []
  const createClient = () => {
    const engine = new ExecutionEngine({ cwd, sessionDir, model: 'fixture', apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, enabledModules: [], maxIterations: 2, permissionMode: 'auto', ...(options.sessionResources ? { systemPrompt: getSystemPrompt(cwd, undefined, sessionDir), sessionSystemPrompt: (directory: string) => getSystemPrompt(cwd, undefined, directory), eventLog: new EventLog(sessionDir) } : { agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] } }) }, observer)
    const client = new AgentSessionClient({ engine, observer, cwd, sessionDir, history: options.history, finalizationGraceMs: options.finalizationGraceMs, onEvent: async event => { events.push(event); await options.onEvent?.(event) } })
    cleanups.push(() => client.dispose().catch(error => { if (!options.expectedDisposalFailure) throw error }))
    return client
  }
  return { client: createClient(), createClient, cwd, sessionDir, events, observer, requests }
}

it('delivers durable events once while keeping the canonical transcript after manual compaction', async () => {
  const history: OpenAIMessage[] = Array.from({ length: 90 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'old ' + index }))
  const { client, observer, events, requests, sessionDir } = await fixture({ history })
  await client.initialize()
  await client.replaceModelWindow([{ role: 'user', content: 'condensed context' }])
  const result = await client.runTurn('next')
  expect(result.result.status, result.result.output).toBe('completed')
  expect(result.newHistory).toHaveLength(92)
  expect(readSessionSnapshot(sessionDir).messages).toEqual(result.newHistory)
  expect(requests[0].messages).toContainEqual({ role: 'user', content: 'condensed context' })
  expect(vi.mocked(observer.streamToken)).not.toHaveBeenCalled()
  expect(events.filter((event): event is Extract<AgentEvent, { type: 'item.delta' }> => event.type === 'item.delta' && event.itemId.startsWith('assistant:')).map(event => event.text).join('')).toBe('ready')
  expect(events.at(-1)?.type).toBe('turn.finished')
})

it('waits for terminal event delivery and rejects overlapping client mutations', async () => {
  let arrived!: () => void, release!: () => void
  const terminal = new Promise<void>(resolve => { arrived = resolve })
  const barrier = new Promise<void>(resolve => { release = resolve })
  const { client } = await fixture({ onEvent: async event => { if (event.type === 'turn.finished') { arrived(); await barrier } } })
  let settled = false
  const pending = client.runTurn('next').then(result => { settled = true; return result })
  await terminal
  expect(settled).toBe(false)
  await expect(client.replaceHistory([])).rejects.toThrow(/active|busy/i)
  release()
  expect((await pending).result.status).toBe('completed')
})

it('switches engines and durable resources together and preserves the old binding after a failed switch', async () => {
  const { client, cwd, sessionDir } = await fixture()
  await client.runTurn('first')
  const original = client.engine
  const other = join(cwd, 'sessions', 'session_other')
  mkdirSync(other)
  saveSession(other, [{ role: 'user', content: 'other session' }]); releaseSessionOwnership(other)
  await client.switchSession(other)
  expect(client.engine).not.toBe(original)
  expect(client.engine.getConfig().sessionDir).toBe(other)
  await client.runTurn('second')
  expect(readSessionSnapshot(sessionDir).messages).toHaveLength(2)
  expect(readSessionSnapshot(other).messages).toHaveLength(3)
  const broken = join(cwd, 'sessions', 'session_broken'); mkdirSync(broken)
  writeFileSync(join(broken, 'history.json'), '{')
  await expect(client.switchSession(broken)).rejects.toThrow()
  expect(client.sessionDir).toBe(other)
  expect((await client.runTurn('third')).result.status).toBe('completed')
})

it('recovers explicitly into a new session without modifying corrupt event evidence or replaying work', async () => {
  const { client, createClient, sessionDir, requests } = await fixture()
  await client.runTurn('saved')
  await client.dispose()
  const manifest = join(sessionDir, 'agent-events', 'manifest.json')
  writeFileSync(manifest, '{corrupt')
  const resumed = createClient()
  await expect(resumed.initialize()).rejects.toThrow(/corrupt/i)
  expect(await resumed.recover()).toHaveLength(2)
  expect(resumed.sessionDir).not.toBe(sessionDir)
  expect(readFileSync(manifest, 'utf8')).toBe('{corrupt')
  expect(requests).toHaveLength(1)
  expect((await resumed.runTurn('explicit new task')).result.status).toBe('completed')
})

it('snapshots submitted images before asynchronous session initialization', async () => {
  const { client } = await fixture()
  let seen: unknown
  const turn = vi.spyOn(client.engine, 'runTurn').mockImplementation((_text, _history, images) => {
    seen = structuredClone(images)
    return Promise.resolve({ result: { stopped: true, reason: 'stop_sequence', status: 'completed', output: '' }, newHistory: [], turnMessages: [] })
  })
  const images = [{ path: 'original.png', dataUrl: 'data:image/png;base64,T1JJR0lOQUw=' }]
  try {
    const submitted = client.runTurn('inspect original', images)
    images[0].path = 'changed.png'
    images[0].dataUrl = 'data:image/png;base64,Q0hBTkdFRA=='
    await submitted
    expect(seen).toEqual([{ path: 'original.png', dataUrl: 'data:image/png;base64,T1JJR0lOQUw=' }])
  } finally { turn.mockRestore() }
})

it('disposes even when an event consumer never settles', async () => {
  let reached!: () => void
  const arrived = new Promise<void>(resolve => { reached = resolve })
  const { client } = await fixture({ onEvent: async () => { reached(); await new Promise(() => {}) } })
  const submitted = client.runTurn('next')
  void submitted.catch(() => {})
  await arrived
  await client.dispose()
  await expect(submitted).rejects.toThrow(/delivery|disposed/i)
})

it('moves generated session prompts and diagnostic logs with the new session engine', async () => {
  const { client, cwd, sessionDir, requests } = await fixture({ sessionResources: true })
  await client.runTurn('first')
  const oldLog = readFileSync(join(sessionDir, 'events.ndjson'), 'utf8')
  const next = join(cwd, 'sessions', 'session_next')
  mkdirSync(next)
  await client.switchSession(next)
  await client.runTurn('second')
  expect(client.engine.getConfig().eventLog?.getFilePath()).toBe(join(next, 'events.ndjson'))
  expect(client.engine.getConfig().systemPrompt).toContain(next)
  expect(client.engine.getConfig().systemPrompt).not.toContain(sessionDir)
  expect(JSON.stringify(requests[1].messages)).toContain(next.replaceAll('\\', '\\\\'))
  expect(readFileSync(join(sessionDir, 'events.ndjson'), 'utf8')).toBe(oldLog)
  expect(readFileSync(join(next, 'events.ndjson'), 'utf8')).toContain('model_request')
})

it('cancels a pending prompt hook promptly and fences the workspace until it physically settles', async () => {
  const { client, cwd, events, requests } = await fixture()
  let release!: () => void
  let hookSignal: AbortSignal | undefined
  const hook = new Promise<void>(resolve => { release = resolve })
  const submitted = client.runTurn('cancel this', undefined, signal => { hookSignal = signal; return hook })
  const rejected = submitted.catch(error => error as Error)
  try {
    await vi.waitFor(() => expect(hookSignal).toBeDefined())
    await client.interrupt()
    expect(await rejected).toMatchObject({ name: 'AbortError' })
    expect(hookSignal!.aborted).toBe(true)
    expect(isWorkspaceQuarantined(cwd)).toBe(true)
    await expect(client.runTurn('too early')).rejects.toThrow(/hook|busy|unfinished/i)
    expect(requests).toHaveLength(0)
    expect(events).toHaveLength(0)
  } finally { release() }
  await vi.waitFor(() => expect(isWorkspaceQuarantined(cwd)).toBe(false))
  expect((await client.runTurn('new instruction')).result.status).toBe('completed')
  expect(requests).toHaveLength(1)
})

it('bounds disposal of an uncooperative prompt hook and preserves its quarantine diagnostic', async () => {
  const { client, cwd, requests } = await fixture({ finalizationGraceMs: 25, expectedDisposalFailure: true })
  let release!: () => void, entered = false
  const hook = new Promise<void>(resolve => { release = resolve })
  const submitted = client.runTurn('cancel this', undefined, () => { entered = true; return hook })
  void submitted.catch(() => {})
  try {
    await vi.waitFor(() => expect(entered).toBe(true))
    await expect(client.dispose()).rejects.toThrow(/settle|unfinished|hook/i)
    await expect(submitted).rejects.toMatchObject({ name: 'AbortError' })
    expect(isWorkspaceQuarantined(cwd)).toBe(true)
    expect(requests).toHaveLength(0)
  } finally { release() }
  await vi.waitFor(() => expect(isWorkspaceQuarantined(cwd)).toBe(false))
  await expect(client.runTurn('closed')).rejects.toThrow(/disposed/i)
})
