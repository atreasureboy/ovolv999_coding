import { expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentServiceError } from '../../src/core/agentService.js'
import { AgentSessionClient } from '../../src/core/agentSessionClient.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import type { EngineObserver } from '../../src/core/engine/observer.js'
import { ACPAgentAdapter } from '../../src/integrations/acp/agentAdapter.js'

function stubClient(interrupt = () => Promise.resolve()) {
  return {
    engine: { getConfig: () => ({ model: 'fixture', cwd: process.cwd(), maxIterations: 2, permissionMode: 'auto' }) },
    activeTurnId: undefined as string | undefined,
    interrupt: vi.fn(interrupt),
    runTurn: vi.fn(() => Promise.reject(new Error('Turn must not start'))),
  }
}

it('honors cancellation while the prompt hook is still pending', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-acp-hook-'))
  const sessionDir = join(cwd, 'session')
  mkdirSync(sessionDir)
  const observer = new Proxy({}, { get: () => vi.fn() }) as EngineObserver
  const engine = new ExecutionEngine({ cwd, sessionDir, model: 'fixture', apiKey: 'local', baseURL: 'http://127.0.0.1:1/v1', maxIterations: 1, permissionMode: 'deny', enabledModules: [] }, observer)
  const model = vi.spyOn(engine, 'runTurn').mockRejectedValue(new Error('Unexpected model start'))
  const client = new AgentSessionClient({ engine, observer, cwd, sessionDir })
  let release!: () => void
  let signal: AbortSignal | undefined
  const hook = new Promise<void>(resolve => { release = resolve })
  const adapter = new ACPAgentAdapter({ client, emit: () => Promise.resolve(), onUserPromptSubmit: (_text, cancellation) => { signal = cancellation; return hook } })
  const message = adapter.handlers.onMessage!('work')
  void message.catch(() => {})
  try {
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(await adapter.handlers.onInterrupt!()).toBe(true)
    await expect(message).rejects.toMatchObject({ name: 'AbortError' })
    expect(signal!.aborted).toBe(true)
    await adapter.drain()
    await expect(adapter.handlers.onMessage!('too early')).rejects.toThrow(/hook|busy|unfinished/)
    expect(model).not.toHaveBeenCalled()
  } finally {
    release()
    await client.dispose()
    model.mockRestore()
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('returns false when an observed turn finishes before its interrupt reaches the service', async () => {
  const client = stubClient(() => Promise.reject(new AgentServiceError('stale_turn', 'Turn already finished')))
  client.activeTurnId = 'finished-turn'
  const adapter = new ACPAgentAdapter({ client: client as unknown as AgentSessionClient, emit: () => Promise.resolve() })
  await expect(adapter.handlers.onInterrupt!('finished-turn')).resolves.toBe(false)
})
