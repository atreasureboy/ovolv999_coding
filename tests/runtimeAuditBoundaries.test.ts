import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { buildMemorySystemSection, getMemoryStats } from '../src/memory/index.js'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { MemoryModule } from '../src/modules/memory.js'
import { HookRunner } from '../src/config/hooks.js'
import { normalizeSettings } from '../src/config/settings/normalization.js'
import { mergeSettingsLayers } from '../src/config/settings/merge.js'
import { ACPServer } from '../src/integrations/acp.js'
import { attachFramedInput } from '../src/integrations/acp/framing.js'
import { parseTscOutput } from '../src/core/diagnostics.js'
import type { EngineConfig } from '../src/core/types.js'

const directories: string[] = []
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'runtime-audit-'))
  directories.push(path)
  return path
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('skips malformed semantic rows while retaining valid startup knowledge', () => {
  const path = directory()
  const valid = { id: 'valid', content: 'Keep reusable instructions', tags: ['rule'], source: 'user_stated', timestamp: '', confidence: 0.9 }
  writeFileSync(join(path, 'semantic.jsonl'), [valid, null, {}, { ...valid, id: 'invalid', tags: null }, { ...valid, id: 'bad-tag', tags: [1] }].map(value => JSON.stringify(value)).join('\n'))
  expect(buildMemorySystemSection(path)).toContain('Keep reusable instructions [rule]')
  expect(getMemoryStats(path)).toEqual({ hasIndex: true, entryCount: 1 })
})

it('injects fallback knowledge from the configured semantic persistence location', () => {
  const path = directory()
  vi.stubEnv('HOME', path)
  vi.stubEnv('USERPROFILE', path)
  const custom = join(path, 'custom')
  mkdirSync(join(custom, 'memory'), { recursive: true })
  writeFileSync(join(custom, 'memory', 'semantic.jsonl'), JSON.stringify({ id: 'custom', content: 'Configured memory survives resume', tags: ['project'], source: 'user_stated', timestamp: '', confidence: 0.9 }) + '\n')
  const module = new MemoryModule(new SemanticMemory(custom), new EpisodicMemory(custom))
  const boot = module.boot({ cwd: path, config: {} as EngineConfig })
  expect(boot.systemPromptSections?.join('\n')).toContain('Configured memory survives resume')
  expect(boot.systemPromptSections?.join('\n')).toContain('unverified')
})

it('normalizes malformed hooks and task context before layered startup merging', () => {
  const settings = normalizeSettings({ hooks: { PreToolCall: 1, OnError: [null, { command: 2 }, { command: 'valid', matcher: 4 }, { command: 'keep' }] }, taskContext: { name: 1, scope: 'src', notes: 'retain' } })
  const merged = mergeSettingsLayers({}, settings)
  expect(merged.hooks?.PreToolCall).toEqual([])
  expect(merged.hooks?.OnError).toEqual([{ command: 'keep' }])
  expect(merged.taskContext).toEqual({ notes: 'retain' })
})

it('reports thrown hook runner errors without interrupting later hooks', () => {
  const failures: string[] = []
  const runner = new HookRunner({ PreToolCall: [{ command: 'broken' }, { command: 'working' }] }, {
    runner: options => {
      if (options.command === 'broken') throw Object.assign(new Error('spawn unavailable'), { code: 'ENOENT' })
      return { ok: true, status: 0, signal: null, durationMs: 0 }
    },
    sink: { warn: message => failures.push(message) },
  })
  expect(runner.runPreToolCall('Read', {})).toMatchObject([{ ok: false, errorCode: 'not_found' }, { ok: true }])
  expect(failures).toHaveLength(1)
})

it('stops processing remaining frames in a chunk when its input is detached', () => {
  const input = new PassThrough()
  const frames: string[] = []
  const detach = attachFramedInput(input, 1024, {
    onFrame: line => { frames.push(line); detach() },
    onError: error => { throw error },
    onClose: () => {},
  })
  input.write('first\nsecond\n')
  expect(frames).toEqual(['first'])
  input.destroy()
})

it('closes ACP admission after shutdown even when more requests share its chunk', () => {
  const input = new PassThrough()
  const output: string[] = []
  const writes: string[] = []
  const server = new ACPServer({ onFileWrite: path => { writes.push(path) } }, { cwd: process.cwd(), write: value => output.push(value) })
  server.start(input)
  input.write([
    { jsonrpc: '2.0', id: 1, method: 'initialize' },
    { jsonrpc: '2.0', id: 2, method: 'shutdown' },
    { jsonrpc: '2.0', id: 3, method: 'initialize' },
    { jsonrpc: '2.0', id: 4, method: 'file/write', params: { path: 'unsafe', content: 'value' } },
  ].map(value => JSON.stringify(value) + '\n').join(''))
  expect(writes).toEqual([])
  expect(input.listenerCount('data')).toBe(0)
  expect(output.map(value => (JSON.parse(value) as { id: number }).id)).toEqual([1, 2])
  server.stop()
  input.destroy()
})

it('keeps TypeScript diagnostic paths relative to the checked workspace', () => {
  const path = directory()
  const diagnostics = parseTscOutput('src/failure.ts(3,2): error TS2322: assignment failed', path)
  expect(diagnostics[0].filePath).toBe(join('src', 'failure.ts'))
})
