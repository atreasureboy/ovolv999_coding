import { createServer, type ServerResponse } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineObserver } from '../../src/core/engine/observer.js'
import type { AgentEvent } from '../../src/core/agentEvents.js'
import type { EngineConfig, OpenAIMessage } from '../../src/core/types.js'
import { claimSessionOwnership, loadSession, readSessionSnapshot, releaseSessionOwnership, saveSession } from '../../src/core/sessionManager.js'
import { resolveResumePath } from '../../src/cli/paths.js'
import { AgentSessionClient } from '../../src/core/agentSessionClient.js'
import { EventLog } from '../../src/core/eventLog.js'
import { getSystemPrompt } from '../../src/prompts/system.js'
import { isWorkspaceQuarantined } from '../../src/core/runContext.js'
import { approvalInputDigest, ApprovalBroker, type ApprovalRequest } from '../../src/core/approvalBroker.js'
import { PermissionManager } from '../../src/core/permissionSystem.js'
import type { ProviderContinuationState } from '../../src/core/model/types.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.unstubAllEnvs() })

async function fixture(options: { history?: OpenAIMessage[]; onEvent?: (event: AgentEvent) => void | Promise<void>; sessionResources?: boolean; finalizationGraceMs?: number; expectedDisposalFailure?: boolean; engineConfig?: Partial<EngineConfig>; respond?: (request: Record<string, unknown>, response: ServerResponse, index: number) => void } = {}) {
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
      if (options.respond) { options.respond(requests.at(-1)!, res, requests.length); return }
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
  const createClient = (directory = sessionDir) => {
    const engine = new ExecutionEngine({ cwd, sessionDir: directory, model: 'fixture', apiKey: 'fixture', baseURL: `http://127.0.0.1:${address.port}/v1`, enabledModules: [], maxIterations: 2, permissionMode: 'auto', ...(options.sessionResources ? { systemPrompt: getSystemPrompt(cwd, undefined, directory), sessionSystemPrompt: (directory: string) => getSystemPrompt(cwd, undefined, directory), eventLog: new EventLog(directory) } : { agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] } }), ...options.engineConfig }, observer)
    const client = new AgentSessionClient({ engine, observer, cwd, sessionDir: directory, history: options.history, finalizationGraceMs: options.finalizationGraceMs, onEvent: async event => { events.push(event); await options.onEvent?.(event) } })
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

it('initializes a resumed junction session after the CLI has already claimed its writer', async () => {
  const { cwd, sessionDir, createClient } = await fixture()
  saveSession(sessionDir, [{ role: 'user', content: 'saved fixture history' }])
  releaseSessionOwnership(sessionDir)
  const alias = join(cwd, 'sessions', 'session_alias')
  symlinkSync(sessionDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const resumed = resolveResumePath(cwd, alias)
  claimSessionOwnership(resumed)
  cleanups.push(() => { releaseSessionOwnership(resumed); return Promise.resolve() })
  expect(loadSession(resumed)).toEqual([{ role: 'user', content: 'saved fixture history' }])
  const client = createClient(resumed)
  await expect(client.initialize()).resolves.toBeUndefined()
  const result = (await client.runTurn('continue')).result
  expect(result.status, JSON.stringify(result)).toBe('completed')
})

it.each([
  { mode: 'ask', bytes: 140000 },
  { mode: 'ask', bytes: 1000 },
  { mode: 'auto', bytes: 140000 },
  { mode: 'deny', bytes: 140000 },
] as const)('keeps $mode approval with $bytes input bytes and the next Read usable', async ({ mode, bytes }) => {
  const broker = new ApprovalBroker()
  const reviewed: ApprovalRequest[] = []
  broker.attachHost({ request: request => {
    reviewed.push(request)
    return Promise.resolve({ requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd, action: 'allow', scope: 'once', status: 'decided' })
  } })
  let target = ''
  const content = 'x'.repeat(bytes)
  const { client, cwd, events } = await fixture({ engineConfig: {
    permissionMode: mode, approvalBroker: broker, maxIterations: 3,
    agent: { identity: { systemPrompt: () => 'fixture' }, tools: ['Write', 'Read'] },
  }, respond: (_request, res, index) => {
    const name = index === 1 ? 'Write' : index === 3 ? 'Read' : undefined
    const input = index === 1 ? { file_path: target, content } : { file_path: target }
    const delta = name ? { tool_calls: [{ index: 0, id: `${name}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } : { content: 'done' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`)
  } })
  target = join(cwd, 'large.txt')
  await client.runTurn('write the generated content')
  expect(isWorkspaceQuarantined(cwd)).toBe(false)
  expect(reviewed).toHaveLength(mode === 'ask' ? 1 : 0)
  if (mode === 'ask') {
    expect(JSON.parse(reviewed[0].preview)).toEqual({ file_path: target, content })
    expect(reviewed[0].inputDigest).toBe(approvalInputDigest({ file_path: target, content }))
    const durable = events.find((event): event is Extract<AgentEvent, { type: 'approval.requested' }> => event.type === 'approval.requested')!
    expect(Buffer.byteLength(JSON.stringify(durable))).toBeLessThan(128 * 1024)
    expect(durable.request.inputDigest).toBe(reviewed[0].inputDigest)
    if (bytes > 128 * 1024) expect(durable.request.preview).toMatch(/truncated/i)
  }
  if (mode === 'deny') expect(existsSync(target)).toBe(false)
  else expect(readFileSync(target, 'utf8')).toBe(content)
  const next = await client.runTurn('read the generated file')
  expect(isWorkspaceQuarantined(cwd)).toBe(false)
  expect(next.result.output).not.toMatch(/recovery|unfinished operations/i)
  if (mode !== 'deny') expect(next.result.status, next.result.output).toBe('completed')
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

it.each(['switch', 'recover'] as const)('requires new Write approval after %s while preserving grants across turns and failed switching', async transition => {
  const broker = new ApprovalBroker()
  const asks: ApprovalRequest[] = []
  broker.attachHost({ request: request => {
    asks.push(request)
    return Promise.resolve({ requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd,
      action: asks.length === 1 ? 'allow' : 'deny', scope: 'session', status: 'decided' })
  } })
  const permissions = new PermissionManager()
  permissions.addRule({ toolName: 'Write', ruleContent: '*', behavior: 'ask', source: 'user' })
  let target = ''
  const { client, cwd, events } = await fixture({ engineConfig: {
    approvalBroker: broker, permissionManager: permissions, permissionMode: 'ask', maxIterations: 3,
    agent: { identity: { systemPrompt: () => 'local fixture' }, tools: ['Read', 'Write'] },
  }, respond: (_request, res, index) => {
    const tool = index % 3 === 1 ? 'Read' : 'Write'
    const input = tool === 'Read' ? { file_path: target } : { file_path: target, content: 'approved content' }
    const delta = index % 3 === 0 ? { content: 'ready' } : { tool_calls: [{ index: 0, id: `tool-${index}`, type: 'function', function: { name: tool, arguments: JSON.stringify(input) } }] }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: index % 3 === 0 ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`)
  } })
  target = join(cwd, 'target.txt')
  writeFileSync(target, 'original content')
  await client.runTurn('write in first session')
  expect(readFileSync(target, 'utf8')).toBe('approved content')
  expect(asks).toHaveLength(1)
  const original = client.threadId
  const broken = join(cwd, 'sessions', 'session_broken_approval')
  mkdirSync(broken)
  writeFileSync(join(broken, 'history.json'), '{')
  await expect(client.switchSession(broken)).rejects.toThrow()
  writeFileSync(target, 'external edit before same-session reuse')
  await client.runTurn('write again in same session')
  expect(readFileSync(target, 'utf8')).toBe('approved content')
  expect(asks).toHaveLength(1)
  if (transition === 'switch') {
    const next = join(cwd, 'sessions', 'session_next_approval')
    mkdirSync(next)
    await client.switchSession(next)
  } else await client.recover()
  expect(client.threadId).not.toBe(original)
  expect(client.engine.getConfig().approvalBroker).toBe(broker)
  writeFileSync(target, 'external edit after session changed')
  await client.runTurn('write in new session')
  expect(asks).toHaveLength(2)
  expect(readFileSync(target, 'utf8')).toBe('external edit after session changed')
  expect(events.filter(event => event.type === 'approval.requested').map(event => event.threadId)).toEqual([original, client.threadId])
})

it('preserves the failed-release binding and cleans up the destination when switching cannot release the old engine', async () => {
  const { client, cwd, sessionDir } = await fixture({ expectedDisposalFailure: true })
  await client.initialize()
  const original = client.engine
  const failure = new Error('old engine cleanup is unfinished')
  const dispose = vi.spyOn(original, 'dispose').mockRejectedValue(failure)
  const next = join(cwd, 'sessions', 'session_failed_release')
  mkdirSync(next)
  try {
    await expect(client.switchSession(next)).rejects.toBe(failure)
    expect(client.sessionDir).toBe(sessionDir)
    expect(client.engine).toBe(original)
    await expect(client.runTurn('must remain fenced')).rejects.toMatchObject({ code: 'thread_releasing' })
    expect(JSON.parse(readFileSync(join(next, 'agent-events', 'manifest.json'), 'utf8')).writer).toBeNull()
    expect(JSON.parse(readFileSync(join(sessionDir, 'agent-events', 'manifest.json'), 'utf8')).writer).not.toBeNull()
    await expect(client.dispose()).rejects.toThrow(/disposal failed/)
    expect(dispose).toHaveBeenCalledTimes(1)
  } finally {
    dispose.mockRestore()
    await original.dispose()
    releaseSessionOwnership(sessionDir)
  }
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

it.each(['switch', 'recover'] as const)('retains explicit model transitions through %s and reopening the earlier session', async transition => {
  const { client, cwd, sessionDir, requests } = await fixture()
  expect((await client.runTurn('Saved under the first model')).result.status).toBe('completed')
  const original = client.getHistory()
  expect(client.getModelWindow().some(message => message.providerState !== undefined)).toBe(true)
  client.engine.setModel('model-b')
  if (transition === 'recover') {
    await client.recover()
    expect(client.sessionDir).not.toBe(sessionDir)
    expect(client.getHistory()).toEqual(original)
  } else {
    const next = join(cwd, 'sessions', 'session_model_switch')
    mkdirSync(next)
    await client.switchSession(next)
  }
  await client.switchSession(sessionDir)
  expect(client.engine.getModel()).toBe('model-b')
  expect(client.getHistory()).toEqual(original)
  const result = await client.runTurn('Continue after reopening')
  expect(result.result.status, result.result.output).toBe('completed')
  expect(requests).toHaveLength(2)
  expect(requests[1].model).toBe('model-b')
  expect(requests[1].messages).toContainEqual({ role: 'user', content: 'Saved under the first model' })
  expect((await client.runTurn('Continue again')).result.status).toBe('completed')
})

it.each(['unknown-model', 'corrupt-state'] as const)('rejects %s after inheriting explicit model transitions into a rebuilt session engine', async corruption => {
  const { client, cwd, sessionDir, requests } = await fixture()
  await client.runTurn('Saved under the first model')
  client.engine.setModel('model-b')
  const next = join(cwd, 'sessions', 'session_model_switch')
  mkdirSync(next)
  await client.switchSession(next)
  const path = join(sessionDir, 'agent-model-window.json')
  const projection = JSON.parse(readFileSync(path, 'utf8')) as { messages: OpenAIMessage[] }
  const state = projection.messages.find(message => message.providerState)?.providerState as ProviderContinuationState
  if (corruption === 'unknown-model') state.model = 'unrecognized-model'
  else state.turns = []
  writeFileSync(path, JSON.stringify(projection))
  await client.switchSession(sessionDir)
  const result = await client.runTurn('Must reject this continuation')
  expect(result.result.status).toBe('failed')
  expect(result.result.output).toMatch(/continuation/i)
  expect(requests).toHaveLength(1)
})
