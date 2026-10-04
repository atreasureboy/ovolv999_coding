import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleKind, transpileModule } from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SemanticMemory } from '../../src/core/semanticMemory.js'
import { EpisodicMemory } from '../../src/core/episodicMemory.js'
import { MemoryModule } from '../../src/modules/memory.js'
import { ReflectionModule } from '../../src/modules/reflection.js'
import { buildMemorySystemSection } from '../../src/memory/index.js'
import type { EngineConfig, ToolContext } from '../../src/core/types.js'

vi.mock('fs', async importOriginal => ({ ...await importOriginal<typeof fs>() }))

const directories: string[] = []
const children: ChildProcess[] = []
const userRef = { sessionId: 'session-one', turnId: 'turn-two', role: 'user' as const }

function setup() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'ovo-memory-supersession-'))
  directories.push(directory)
  const memory = new SemanticMemory(directory)
  const module = new MemoryModule(memory, new EpisodicMemory(directory))
  const context = { cwd: directory, config: {} as EngineConfig }
  const tools = module.boot(context).tools!
  return { directory, memory, module, context, write: tools.find(tool => tool.name === 'memory_write')!, search: tools.find(tool => tool.name === 'memory_search')! }
}

function entry(content: string, source = 'user_stated') {
  return { content, source, tags: ['convention'], timestamp: '2026-01-01T00:00:00Z', confidence: 0.8 }
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Memory fixture did not close')), 2_000)
      child.once('close', () => { clearTimeout(timer); resolve() })
      child.kill()
    })
  }
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('explicit memory corrections', () => {
  it('uses the existing write tool to replace user knowledge while preserving an auditable origin across restart', async () => {
    const { directory, memory, module, context, write, search } = setup()
    const oldRef = { ...userRef, turnId: 'turn-one' }
    const old = memory.write({ ...entry('Use npm for package installation'), sourceRef: oldRef })
    const result = await write.execute({ ...entry('Use pnpm for package installation'), supersedes: [old.id], sourceRef: userRef }, { cwd: directory } as ToolContext)
    expect(result.isError).toBe(false)
    const audit = new SemanticMemory(directory).readAll()
    expect(audit).toHaveLength(2)
    expect(audit.find(value => value.id === old.id)).toMatchObject({ content: 'Use npm for package installation', state: 'superseded', sourceRef: oldRef })
    expect(audit.find(value => value.id !== old.id)).toMatchObject({ state: 'active', supersedes: [old.id], sourceRef: userRef, provenance: { status: 'unverified' } })
    for (const userMessage of [undefined, 'package installation']) {
      const prompt = module.boot({ ...context, userMessage }).systemPromptSections?.join('\n') ?? ''
      expect(prompt).toContain('Use pnpm for package installation')
      expect(prompt).not.toContain('Use npm for package installation')
    }
    expect(buildMemorySystemSection(join(directory, 'memory'))).not.toContain('Use npm for package installation')
    expect(memory.search({ tags: ['convention'], keywords: ['installation'] }).map(value => value.content)).toEqual(['Use pnpm for package installation'])
    const found = await search.execute({ query: 'installation' }, { cwd: directory } as ToolContext)
    expect(found.content).toContain(audit.find(value => value.id !== old.id)!.id)
  })

  it('keeps unrelated bilingual facts active without inferring replacement from lexical overlap', async () => {
    const { directory, memory, write } = setup()
    const old = memory.write(entry('Use pnpm for dependencies in the frontend'))
    const result = await write.execute({ ...entry('后端使用 pnpm 管理依赖'), sourceRef: userRef }, { cwd: directory } as ToolContext)
    expect(result.isError).toBe(false)
    expect(memory.search({}).map(value => value.content).sort()).toEqual(['Use pnpm for dependencies in the frontend', '后端使用 pnpm 管理依赖'].sort())
    expect(memory.readAll().find(value => value.id === old.id)).toMatchObject({ state: 'active' })
  })

  it('defaults legacy rows to active while skipping malformed new lifecycle metadata', () => {
    const { directory, memory, module, context } = setup()
    const legacy = { ...entry('Legacy project convention remains usable'), id: 'legacy' }
    fs.writeFileSync(join(directory, 'memory', 'semantic.jsonl'), [legacy,
      { ...legacy, id: 'bad-state', content: 'Invalid lifecycle must not be injected', state: 'deleted' },
      { ...legacy, id: 'bad-links', supersedes: [4] },
      { ...legacy, id: 'bad-ref', sourceRef: { ...userRef, role: 'tool' } },
    ].map(value => JSON.stringify(value)).join('\n'))
    expect(memory.readAll()).toMatchObject([{ id: 'legacy', state: 'active' }])
    expect(module.boot(context).systemPromptSections?.join('\n')).toContain(legacy.content)
    expect(buildMemorySystemSection(join(directory, 'memory'))).not.toContain('Invalid lifecycle')
  })

  it.each(['agent_inferred', 'consolidation', 'tool_observed'])('rejects %s replacing a user rule before committing either row', source => {
    const { directory, memory } = setup()
    const old = memory.write(entry('User requires isolated worktrees'))
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    const result = memory.write({ ...entry('Prefer editing the shared checkout', source), supersedes: [old.id] })
    expect(result).toMatchObject({ persistence: 'failed' })
    expect(result.persistenceError).toMatch(/source|priority|user/i)
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
    const replacement = memory.write(entry('Ordinary extracted observation', source))
    const directBefore = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    expect(() => memory.supersedeMemory([old.id], replacement.id)).toThrow(/source|priority|user/i)
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(directBefore)
  })

  it('supersedes existing rows atomically and rejects unknown, self and stale references', () => {
    const { directory, memory } = setup()
    const old = memory.write(entry('Original editor convention'))
    const replacement = memory.write(entry('Corrected editor convention'))
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    expect(() => memory.supersedeMemory(['unknown'], replacement.id)).toThrow(/unknown/i)
    expect(() => memory.supersedeMemory([old.id], 'unknown')).toThrow(/unknown/i)
    expect(() => memory.supersedeMemory([replacement.id], replacement.id)).toThrow(/self/i)
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
    memory.supersedeMemory([old.id], replacement.id)
    expect(new SemanticMemory(directory).search({}).map(value => value.id)).toEqual([replacement.id])
    expect(new SemanticMemory(directory).readAll().find(value => value.id === replacement.id)).toMatchObject({ supersedes: [old.id] })
    expect(() => memory.supersedeMemory([old.id], replacement.id)).toThrow(/stale|superseded/i)
    expect(() => memory.supersedeMemory([replacement.id], old.id)).toThrow(/stale|superseded/i)
  })

  it('rejects imported cyclic ancestry without altering audit rows', () => {
    const { directory, memory } = setup()
    const rows = [
      { ...entry('Earlier imported convention'), id: 'earlier', state: 'active', supersedes: ['later'] },
      { ...entry('Later imported convention'), id: 'later', state: 'active' },
    ]
    const before = rows.map(value => JSON.stringify(value)).join('\n')
    fs.writeFileSync(join(directory, 'memory', 'semantic.jsonl'), before)
    expect(() => memory.supersedeMemory(['earlier'], 'later')).toThrow(/cycl/i)
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
  })

  it('does not revive an obsolete user rule through duplicate automatic extraction', () => {
    const { memory } = setup()
    const old = memory.write(entry('User requires npm commands'))
    const replacement = memory.write({ ...entry('User now requires pnpm commands'), supersedes: [old.id], sourceRef: userRef })
    expect(replacement.persistence).toBe('persisted')
    memory.write(entry('User requires npm commands', 'agent_inferred'))
    expect(memory.search({}).map(value => value.content)).toEqual(['User now requires pnpm commands'])
    const restored = memory.write({ ...entry('User requires npm commands'), supersedes: [replacement.id], sourceRef: { ...userRef, turnId: 'turn-three' } })
    expect(restored.persistence).toBe('persisted')
    expect(restored.id).not.toBe(old.id)
    expect(memory.search({}).map(value => value.id)).toEqual([restored.id])
    expect(memory.readAll()).toHaveLength(3)
  })

  it('does not commit a replacement on stale cached IDs from another writer', () => {
    const { directory, memory } = setup()
    const old = memory.write(entry('Initial user build convention'))
    const other = new SemanticMemory(directory)
    other.write({ ...entry('Updated external build convention'), supersedes: [old.id] })
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    expect(memory.write({ ...entry('Stale local build correction'), supersedes: [old.id] })).toMatchObject({ persistence: 'failed' })
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
    expect(memory.search({}).map(value => value.content)).toEqual(['Updated external build convention'])
  })

  it.each(['readAll', 'search'] as const)('keeps %s lifecycle snapshots detached from the injection cache', method => {
    const { directory, memory, module, context } = setup()
    const old = memory.write(entry('Obsolete rule in snapshot audit'))
    const replacement = memory.write({ ...entry('Active rule remains authoritative'), supersedes: [old.id], sourceRef: userRef })
    const snapshot = (method === 'readAll' ? memory.readAll() : memory.search({})).find(value => value.id === replacement.id)!
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    snapshot.state = 'superseded'
    snapshot.supersedes!.push('uncommitted-link')
    snapshot.sourceRef!.turnId = 'uncommitted-turn'
    snapshot.tags.push('uncommitted-tag')
    expect(module.boot(context).systemPromptSections?.join('\n')).toContain('Active rule remains authoritative')
    expect(memory.search({}).map(value => value.id)).toEqual([replacement.id])
    expect(memory.readAll().find(value => value.id === replacement.id)).toMatchObject({ supersedes: [old.id], sourceRef: userRef, tags: ['convention'] })
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
  })

  it('owns asynchronous correction metadata before waiting for its persistence lease', async () => {
    const { memory } = setup()
    const old = memory.write(entry('User rule before asynchronous correction'))
    const input = { ...entry('User rule after asynchronous correction'), supersedes: [old.id], sourceRef: { ...userRef } }
    const pending = memory.writeAsync(input)
    input.supersedes.push('caller-added-unknown')
    input.sourceRef.turnId = 'caller-overwritten-turn'
    input.tags.push('caller-overwritten-tag')
    const result = await pending
    expect(result.persistence).toBe('persisted')
    expect(memory.search({})).toMatchObject([{ content: 'User rule after asynchronous correction', supersedes: [old.id], sourceRef: userRef, tags: ['convention'] }])
  })

  it('withholds stale knowledge when a committed external correction cannot be refreshed and recovers on retry', async () => {
    const { directory, memory, module, context } = setup()
    const old = memory.write(entry('Old user convention before refresh failure'))
    memory.readAll()
    const other = new SemanticMemory(directory)
    expect((await other.writeAsync({ ...entry('New user convention after committed correction'), supersedes: [old.id] })).persistence).toBe('persisted')
    const read = fs.readFileSync
    const failure = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (typeof args[0] === 'string' && args[0].endsWith('semantic.jsonl')) throw Object.assign(new Error('read denied'), { code: 'EACCES' })
      return read(...args)
    })
    expect(memory.search({})).toEqual([])
    expect(memory.readAll()).toEqual([])
    expect(module.boot(context).systemPromptSections).toEqual([])
    failure.mockRestore()
    expect(memory.search({}).map(value => value.content)).toEqual(['New user convention after committed correction'])
    const prompt = module.boot(context).systemPromptSections?.join('\n') ?? ''
    expect(prompt).toContain('New user convention after committed correction')
    expect(prompt).not.toContain('Old user convention before refresh failure')
    expect(memory.readAll()).toHaveLength(2)
  })

  it.each([
    { ...userRef, sessionId: 's'.repeat(2 * 1024 * 1024) },
    { ...userRef, sessionId: 's'.repeat(4097) },
    { ...userRef, sessionId: '旧'.repeat(1366) },
    { ...userRef, turnId: 't'.repeat(129) },
    { ...userRef, turnId: '旧'.repeat(43) },
    { ...userRef, extra: 'e'.repeat(2 * 1024 * 1024) },
  ])('rejects oversized or unknown origin fields without altering persisted memory: %#', async sourceRef => {
    const { directory, memory, write } = setup()
    memory.write(entry('Existing convention before oversized origin'))
    const file = join(directory, 'memory', 'semantic.jsonl')
    const before = fs.readFileSync(file, 'utf8')
    const result = await write.execute({ ...entry('Rejected oversized origin metadata'), sourceRef }, { cwd: directory, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(memory.readAll()).toHaveLength(1)
  })

  it('accepts precise UTF-8 origin boundaries while retaining unverified attribution', async () => {
    const { directory, memory, write } = setup()
    const sourceRef = { sessionId: '😀'.repeat(1024), turnId: '😀'.repeat(32), role: 'user' }
    const result = await write.execute({ ...entry('Valid bounded origin metadata'), sourceRef }, { cwd: directory, permissionMode: 'auto' })
    expect(result.isError).toBe(false)
    expect(new SemanticMemory(directory).readAll()).toMatchObject([{ sourceRef, provenance: { status: 'unverified' } }])
    expect(memory.search({})).toHaveLength(1)
  })

  it.each(['i'.repeat(129), '旧'.repeat(43)])('refuses overlong supersession identifiers even when the imported old row exists: %#', id => {
    const { directory, memory } = setup()
    const file = join(directory, 'memory', 'semantic.jsonl')
    const before = JSON.stringify({ ...entry('Imported predecessor with an overlong ID'), id }) + '\n'
    fs.writeFileSync(file, before)
    expect(memory.write({ ...entry('Rejected overlong predecessor reference'), supersedes: [id] })).toMatchObject({ persistence: 'failed' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('rejects too many explicit predecessor IDs before committing a wide correction', () => {
    const { directory, memory } = setup()
    const rows = Array.from({ length: 257 }, (_, index) => ({ ...entry('Convention ' + index), id: 'old-' + index, state: 'active' }))
    const file = join(directory, 'memory', 'semantic.jsonl')
    const before = rows.map(value => JSON.stringify(value)).join('\n')
    fs.writeFileSync(file, before)
    expect(memory.write({ ...entry('Rejected overly wide correction'), supersedes: rows.map(value => value.id) })).toMatchObject({ persistence: 'failed' })
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it('rejects merged ancestry overflow before an existing replacement can become unreadable on restart', () => {
    const { directory, memory } = setup()
    const ancestors = Array.from({ length: 256 }, (_, index) => ({ ...entry('Historical convention ' + index), id: 'old-' + index, state: 'superseded' }))
    const rows = [...ancestors,
      { ...entry('Existing replacement with bounded ancestry'), id: 'replacement', state: 'active', supersedes: ancestors.map(value => value.id) },
      { ...entry('Additional active convention'), id: 'additional', state: 'active' },
    ]
    const file = join(directory, 'memory', 'semantic.jsonl')
    const before = rows.map(value => JSON.stringify(value)).join('\n')
    fs.writeFileSync(file, before)
    expect(() => memory.supersedeMemory(['additional'], 'replacement')).toThrow(/supersession|metadata|limit/i)
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
    expect(new SemanticMemory(directory).search({}).map(value => value.id).sort()).toEqual(['additional', 'replacement'])
  })

  it('preserves both rows and clears temporary files when an atomic correction rename fails', () => {
    const { directory, memory } = setup()
    const old = memory.write(entry('Committed convention before failure'))
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    const rename = fs.renameSync
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to).endsWith('semantic.jsonl')) throw new Error('rename denied')
      return rename(from, to)
    })
    expect(memory.write({ ...entry('Uncommitted replacement convention'), supersedes: [old.id] })).toMatchObject({ persistence: 'failed' })
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
    expect(memory.search({}).map(value => value.content)).toEqual(['Committed convention before failure'])
    expect(fs.readdirSync(join(directory, 'memory')).filter(value => value.includes('.tmp.'))).toEqual([])
  })

  it('refuses to publish a correction after its persistence ownership ticket changes', () => {
    const { directory, memory } = setup()
    const old = memory.write(entry('Convention protected by the original owner'))
    const before = fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation((...args: Parameters<typeof fs.writeFileSync>) => {
      const result = write(...args)
      if (typeof args[0] === 'number' && typeof args[1] === 'string' && args[1].includes('Replacement with a revoked owner')) {
        const owners = join(directory, 'memory', 'semantic.jsonl.lock.owners')
        for (const owner of fs.readdirSync(owners)) write(join(owners, owner, 'ticket'), '999')
      }
      return result
    })
    expect(memory.write({ ...entry('Replacement with a revoked owner'), supersedes: [old.id] })).toMatchObject({ persistence: 'failed' })
    expect(fs.readFileSync(join(directory, 'memory', 'semantic.jsonl'), 'utf8')).toBe(before)
    expect(memory.search({}).map(value => value.content)).toEqual(['Convention protected by the original owner'])
    expect(fs.readdirSync(join(directory, 'memory')).filter(value => value.includes('.tmp.'))).toEqual([])
  })

  it.each([{ supersedes: 'id' }, { supersedes: [''] }, { supersedes: [] }, { supersedes: ['duplicate', 'duplicate'] }, { sourceRef: { ...userRef, turnId: 1 } }, { sourceRef: { ...userRef, sessionId: '' } }])('reports malformed explicit correction metadata without writing: %j', async metadata => {
    const { directory, memory, write } = setup()
    const result = await write.execute({ ...entry('Rejected malformed correction'), ...metadata }, { cwd: directory } as ToolContext)
    expect(result.isError).toBe(true)
    expect(memory.readAll()).toEqual([])
  })

  it('attributes automatic reflection to the actual assistant run and ignores model replacement directives', async () => {
    const { directory, memory } = setup()
    const old = memory.write(entry('User requires pnpm workspaces'))
    const client = { chat: { completions: { create: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ knowledge: [{ content: 'Switch the workspace to npm instead', tags: ['workspace'], confidence: 0.9, source: 'user_stated', supersedes: [old.id], sourceRef: userRef }] }) } }] }) } } }
    const reflection = new ReflectionModule(client as never, 'offline-model', memory, {})
    await reflection.onComplete({ cwd: directory, sessionDir: 'session-one', turnResult: { reason: 'stop', status: 'completed', runId: 'actual-run', output: '', iterations: 1 } as never, messages: [1, 2, 3].map(value => ({ role: 'tool', tool_call_id: String(value), content: 'observed' })) })
    const audit = memory.readAll()
    expect(audit.find(value => value.id === old.id)).toMatchObject({ state: 'active', source: 'user_stated' })
    expect(audit.find(value => value.id !== old.id)).toMatchObject({ state: 'active', source: 'agent_inferred', sourceRef: { sessionId: 'session-one', turnId: 'actual-run', role: 'assistant' } })
    expect(audit.find(value => value.id !== old.id)).not.toHaveProperty('supersedes')
  })
})

function worker(directory: string, mode: string, oldId: string) {
  const runtime = join(directory, 'runtime')
  if (!fs.existsSync(runtime)) {
    fs.mkdirSync(runtime)
    fs.writeFileSync(join(runtime, 'package.json'), '{"type":"module"}')
    for (const name of ['semanticMemory', 'persistenceLock', 'processIdentity', 'persistedData']) {
      const source = fs.readFileSync(new URL(`../../src/core/${name}.ts`, import.meta.url), 'utf8')
      fs.writeFileSync(join(runtime, `${name}.js`), transpileModule(source, { compilerOptions: { module: ModuleKind.ESNext, target: 9 } }).outputText)
    }
  }
  const fixture = fileURLToPath(new URL('../fixtures/semanticCorrectionWriter.mjs', import.meta.url))
  const child = fork(fixture, [directory, mode, pathToFileURL(join(runtime, 'semanticMemory.js')).href, oldId], { execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.push(child)
  const messages: unknown[] = []
  let stderr = ''
  let closed = false
  child.stderr?.on('data', data => { stderr += String(data) })
  child.on('error', error => { stderr += error.message })
  child.on('message', value => messages.push(value))
  child.on('close', () => { closed = true })
  return { child, messages, get closed() { return closed }, diagnostics: () => `${mode}: ${stderr}\n${JSON.stringify(messages)}` }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 8_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Native memory worker did not reach its barrier')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

it.each(['append', 'stale-correction'])('serializes a native correction against a competing %s with fresh disk validation', async mode => {
  const { directory, memory } = setup()
  const old = memory.write(entry('Native original convention'))
  const correction = worker(directory, 'correction', old.id)
  const competitor = worker(directory, mode, old.id)
  await until(() => correction.messages.includes('ready') && competitor.messages.includes('ready'))
  correction.child.send('start')
  await until(() => correction.messages.includes('rewriting') || correction.closed)
  expect(correction.messages, correction.diagnostics()).toContain('rewriting')
  competitor.child.send('start')
  await until(() => competitor.messages.includes('contended') || competitor.closed)
  expect(competitor.messages, competitor.diagnostics()).toContain('contended')
  fs.writeFileSync(join(directory, 'release-correction'), '')
  await until(() => correction.closed && competitor.closed)
  expect(correction.child.exitCode, correction.diagnostics()).toBe(0)
  expect(competitor.child.exitCode, competitor.diagnostics()).toBe(0)
  expect(correction.messages).toContainEqual({ persistence: 'persisted' })
  expect(competitor.messages).toContainEqual({ persistence: mode === 'append' ? 'persisted' : 'failed' })
  const restarted = new SemanticMemory(directory)
  expect(restarted.readAll().find(value => value.id === old.id)).toMatchObject({ state: 'superseded' })
  expect(restarted.search({}).map(value => value.content).sort()).toEqual(mode === 'append' ? ['Native corrected convention', 'Native unrelated fact'] : ['Native corrected convention'])
}, 20_000)
