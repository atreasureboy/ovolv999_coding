import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type OpenAI from 'openai'
import { afterEach, expect, it, vi } from 'vitest'
import { ExecutionEngine } from '../../../src/core/engine.js'
import { createCliPermissionManager } from '../../../src/cli/permissions.js'
import type { PermissionMode } from '../../../src/core/permissionSystem.js'
import type { EngineObserver } from '../../../src/core/engine/observer.js'

const fixtures: Array<{ engine: ExecutionEngine; cwd: string }> = []
afterEach(async () => {
  for (const { engine, cwd } of fixtures.splice(0)) {
    await engine.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

function setup(calls: Array<{ name: string; command?: string; input?: Record<string, unknown> }>, mode: PermissionMode = 'default', approved = false) {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-shell-approval-'))
  vi.stubEnv('OVOGO_STATE_DIR', join(cwd, 'state'))
  const manager = createCliPermissionManager({ mode })
  const approvals: Array<{ tool: string; command: unknown }> = []
  let request = 0
  const client = { chat: { completions: { create: () => Promise.resolve((async function* () {
    if (++request === 1) yield await Promise.resolve({ choices: [{ delta: { tool_calls: calls.map((call, index) => ({ index, id: `shell-${index}`, function: { name: call.name, arguments: JSON.stringify(call.input ?? { command: call.command }) } })) }, finish_reason: 'tool_calls' }] })
    else yield await Promise.resolve({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] })
  })()) } } } as unknown as OpenAI
  const observer = new Proxy({}, { get: () => () => undefined }) as EngineObserver
  const engine = new ExecutionEngine({ cwd, sessionDir: join(cwd, 'session'), model: 'fixture', apiKey: 'fixture', maxIterations: 2, enabledModules: [], permissionMode: 'auto', permissionManager: manager, requestPermission: (tool, input) => { approvals.push({ tool, command: input.command }); return Promise.resolve({ approved }) } }, observer, client)
  fixtures.push({ engine, cwd })
  return { engine, cwd, manager, approvals }
}

it.each(['default', 'acceptEdits'] as const)('reviews foreground and background shell effects in %s mode', async mode => {
  const command = 'echo marker > marker.txt'
  const { engine, cwd, approvals } = setup([{ name: 'Bash', command }, { name: 'TaskCreate', command }], mode)
  await engine.runTurn('Run the fixture', [])
  await Promise.all(engine.getBackgroundTaskManager().listTasks().map(task => engine.getBackgroundTaskManager().waitForTask(task.id, 3000)))
  expect(approvals.map(request => request.tool)).toEqual(['Bash', 'TaskCreate'])
  expect(existsSync(join(cwd, 'marker.txt'))).toBe(false)
  expect(engine.getBackgroundTaskManager().listTasks()).toEqual([])
})

it('reviews file-writing find options before the real Bash tool executes', async () => {
  const command = 'find . -maxdepth 0 -fprint marker.txt'
  const { engine, cwd, approvals } = setup([{ name: 'Bash', command }])
  await engine.runTurn('Run the fixture', [])
  expect(approvals).toEqual([{ tool: 'Bash', command }])
  expect(existsSync(join(cwd, 'marker.txt'))).toBe(false)
})

it('executes an approved background command and keeps explicit denial stronger than safe classification', async () => {
  const { engine, cwd, approvals, manager } = setup([{ name: 'Bash', command: 'echo safe' }, { name: 'TaskCreate', command: 'echo marker > marker.txt' }], 'default', true)
  manager.addRule({ toolName: 'Bash', ruleContent: '*', behavior: 'deny', source: 'user' })
  const result = await engine.runTurn('Run the fixture', [])
  await Promise.all(engine.getBackgroundTaskManager().listTasks().map(task => engine.getBackgroundTaskManager().waitForTask(task.id, 3000)))
  expect(approvals.map(request => request.tool)).toEqual(['TaskCreate'])
  expect(readFileSync(join(cwd, 'marker.txt'), 'utf8').trim()).toBe('marker')
  expect(result.newHistory.find(message => message.name === 'Bash')?.content).toMatch(/Permission denied/)
})

it('permits recognized read-only shell commands without prompting', async () => {
  const { engine, approvals } = setup([{ name: 'Bash', command: 'echo readonly' }, { name: 'TaskCreate', command: 'echo readonly' }])
  await engine.runTurn('Read the fixture', [])
  const tasks = engine.getBackgroundTaskManager().listTasks()
  const results = await Promise.all(tasks.map(task => engine.getBackgroundTaskManager().waitForTask(task.id, 3000)))
  expect(approvals).toEqual([])
  expect(results).toMatchObject([{ status: 'completed', exitCode: 0 }])
})

it('requires explicit approval of read-only tools under the strict runtime policy', async () => {
  const { engine, approvals, manager } = setup([{ name: 'Read', input: { file_path: 'unread.txt' } }], 'bypassPermissions')
  manager.addRule({ toolName: 'Read', ruleContent: '*', behavior: 'allow', source: 'user' })
  engine.getConfig().requireToolApproval = true
  const outcome = await engine.runTurn('Read the fixture', [])
  expect(approvals.map(request => request.tool)).toEqual(['Read'])
  expect(outcome.newHistory.find(message => message.name === 'Read')?.content).toMatch(/Permission denied/)
})
