import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import { ExecutionEngine } from '../../src/core/engine.js'
import { AgentSessionClient } from '../../src/core/agentSessionClient.js'
import type { AgentEvent } from '../../src/core/agentEvents.js'
import type { EngineConfig, OpenAIMessage } from '../../src/core/types.js'
import type { Renderer } from '../../src/ui/renderer.js'

export async function loopFixture(options: {
  check?: string; acceptance?: string; history?: OpenAIMessage[]; deadlineMs?: number; finalizationGraceMs?: number
  engineConfig?: Partial<EngineConfig>; onEvent?: (event: AgentEvent) => void | Promise<void>
  respond?: (index: number, response: ServerResponse, cwd: string) => void
} = {}) {
  const base = mkdtempSync(join(tmpdir(), 'ovo-loop-controller-'))
  const cwd = join(base, 'workspace'), sessionDir = join(cwd, 'sessions', 'session_loop'), loopDir = join(cwd, '.loop')
  mkdirSync(sessionDir, { recursive: true }); mkdirSync(loopDir)
  writeFileSync(join(loopDir, 'GOAL.md'), 'Pass the frozen check')
  writeFileSync(join(loopDir, 'ACCEPTANCE.md'), options.acceptance ?? '- [ ] A1: check `node check.cjs`')
  writeFileSync(join(cwd, 'check.cjs'), options.check ?? 'process.exit(0)')
  vi.stubEnv('OVOGO_STATE_DIR', join(base, 'runtime'))
  const requests: Record<string, unknown>[] = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', data => { body += String(data) })
    req.on('end', () => {
      requests.push(JSON.parse(body) as Record<string, unknown>)
      if (options.respond) return options.respond(requests.length, res, cwd)
      reply(res)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing provider address')
  const renderer = new Proxy({}, { get: (_target, key) => key === 'then' ? undefined : vi.fn() }) as Renderer
  const clients: AgentSessionClient[] = []
  const createClient = () => {
    const engine = new ExecutionEngine({ cwd, sessionDir, model: 'fixture', apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${address.port}/v1`, enabledModules: [], maxIterations: 4, permissionMode: 'auto', agent: { identity: { systemPrompt: () => 'fixture' }, tools: [] }, ...options.engineConfig }, renderer)
    const client = new AgentSessionClient({ engine, observer: renderer, cwd, sessionDir, history: options.history, deadlineMs: options.deadlineMs, finalizationGraceMs: options.finalizationGraceMs, onEvent: options.onEvent })
    clients.push(client)
    return client
  }
  const client = createClient()
  return { base, cwd, loopDir, sessionDir, client, createClient, renderer, requests,
    config: { cwd, loopDir, maxIters: 4 },
    close: async () => {
      for (const client of clients) await client.dispose()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      rmSync(base, { recursive: true, force: true })
    },
  }
}

export function reply(response: ServerResponse): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  response.end('data: {"choices":[{"index":0,"delta":{"content":"ready"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
}
