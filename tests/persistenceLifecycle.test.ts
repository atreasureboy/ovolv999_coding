import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SemanticMemory } from '../src/core/semanticMemory.js'
import { FileHistory, MAX_VERSIONS_PER_FILE } from '../src/core/fileHistory.js'
import { MemoryModule } from '../src/modules/memory.js'
import { EpisodicMemory } from '../src/core/episodicMemory.js'
import { ReflectionModule } from '../src/modules/reflection.js'
import type { EngineConfig, ToolContext } from '../src/core/types.js'

vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) }
})

const dirs: string[] = []
function directory(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'ovo-persistence-'))
  dirs.push(dir)
  return dir
}
function entry(content: string) {
  return { content, tags: ['test'], source: 'user_stated', confidence: 0.8, timestamp: '' }
}

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('persistence failure contracts', () => {
  it('episodic append failures are reported and retained on-disk entries are counted before appending', () => {
    const dir = directory()
    const memory = new EpisodicMemory(dir, { maxEpisodes: 2 })
    const episode = { turn: 1, toolName: 'Read', inputSummary: '', resultSummary: '', outcome: 'success' as const, timestamp: '' }
    memory.write(episode)
    memory.write(episode)
    const resumed = new EpisodicMemory(dir, { maxEpisodes: 2 })
    expect(resumed.write(episode)).toMatchObject({ persistence: 'persisted' })
    expect(resumed.readAll()).toHaveLength(2)
    fs.unlinkSync(join(dir, 'memory', 'episodes.jsonl'))
    fs.mkdirSync(join(dir, 'memory', 'episodes.jsonl'))
    expect(resumed.write(episode)).toMatchObject({ persistence: 'failed' })
  })

  it('memory_write reports a real disk failure instead of Stored', async () => {
    const dir = directory()
    const semantic = new SemanticMemory(dir)
    fs.mkdirSync(join(dir, 'memory', 'semantic.jsonl'))
    const module = new MemoryModule(semantic, new EpisodicMemory(dir))
    const tools = module.boot({ cwd: dir, config: {} as EngineConfig }).tools!
    const result = await tools.find(tool => tool.name === 'memory_write')!.execute(entry('Never claim an unwritten memory'), { cwd: dir } as ToolContext)
    expect(result.isError).toBe(true)
    expect(result.content).not.toContain('Stored')
  })

  it('a transient read failure preserves the previous view and retries unchanged file metadata', () => {
    const dir = directory()
    const semantic = new SemanticMemory(dir)
    semantic.write(entry('previous valid memory'))
    const other = new SemanticMemory(dir)
    other.write(entry('new externally written memory'))
    const read = vi.spyOn(fs, 'readFileSync')
    read.mockImplementationOnce(() => { throw new Error('temporary read failure') })
    expect(semantic.readAll().map(value => value.content)).toEqual(['previous valid memory'])
    read.mockRestore()
    expect(semantic.readAll()).toHaveLength(2)
  })

  it('a claimed user source has no fabricated verified provenance', () => {
    const semantic = new SemanticMemory(directory())
    const saved = semantic.write(entry('A model claims this was user stated'))
    expect(saved).toMatchObject({ provenance: { status: 'unverified', claimedSource: 'user_stated' } })
    expect(new SemanticMemory(dirs[dirs.length - 1]).readAll()[0]).toMatchObject({ provenance: { status: 'unverified' } })
  })

  it('reports a rewrite failure while preserving committed content and removing temporary files', () => {
    const dir = directory()
    const semantic = new SemanticMemory(dir)
    semantic.write({ ...entry('unchanged disk memory'), confidence: 0.4 })
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('rename denied') })
    expect(semantic.write({ ...entry('unchanged disk memory'), confidence: 0.9 }).persistence).toBe('failed')
    expect(new SemanticMemory(dir).readAll()[0].confidence).toBe(0.4)
    expect(fs.readdirSync(join(dir, 'memory'))).toEqual(['semantic.jsonl'])
  })

  it('preserves the original baseline when recent versions are evicted', () => {
    const dir = directory()
    const file = join(dir, 'file.txt')
    fs.writeFileSync(file, 'original baseline')
    const history = new FileHistory(dir)
    for (let index = 0; index < MAX_VERSIONS_PER_FILE + 4; index++) {
      history.trackEdit(file)
      fs.writeFileSync(file, `edit ${index}`)
    }
    expect(history.getVersions(file)).toHaveLength(MAX_VERSIONS_PER_FILE)
    expect(history.restoreOriginal(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('original baseline')
  })

  it('records and restores absent baselines across restart, including child workspaces', () => {
    const dir = directory()
    const workspace = join(dir, 'child')
    fs.mkdirSync(workspace)
    const file = join(workspace, 'new.txt')
    const history = new FileHistory(dir)
    history.trackEdit(file)
    fs.writeFileSync(file, 'new child artifact')
    const resumed = new FileHistory(dir)
    expect(resumed.getEditedFiles()).toMatchObject([{ path: file, changeKind: 'added' }])
    expect(resumed.restoreOriginal(file)).toBe(true)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('lists deleted files and restores their original baseline after a restart', () => {
    const dir = directory()
    const file = join(dir, 'deleted.txt')
    fs.writeFileSync(file, 'deleted baseline')
    const history = new FileHistory(dir)
    history.trackEdit(file)
    fs.unlinkSync(file)
    const resumed = new FileHistory(dir)
    expect(resumed.getEditedFiles()).toMatchObject([{ path: file, changeKind: 'deleted', baselineStatus: 'recorded' }])
    expect(resumed.restoreOriginal(file)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('deleted baseline')
  })

  it('keeps legacy snapshots usable without inventing an original baseline', () => {
    const dir = directory()
    const file = join(dir, 'legacy.txt')
    fs.writeFileSync(file, 'oldest retained version')
    const history = new FileHistory(dir)
    history.trackEdit(file)
    const backup = history.getVersions(file)[0].backupPath
    fs.writeFileSync(`${backup}.meta.json`, JSON.stringify({ originalPath: file }))
    fs.writeFileSync(file, 'current')
    const resumed = new FileHistory(dir)
    expect(resumed.getEditedFiles()[0].baselineStatus).toBe('unknown')
    expect(resumed.restoreOriginal(file)).toBe(false)
    expect(resumed.restoreVersion(file, 0)).toBe(true)
    expect(fs.readFileSync(file, 'utf8')).toBe('oldest retained version')
  })

  it('reports backup failure and does not claim the file is recoverable', () => {
    const dir = directory()
    const file = join(dir, 'file.txt')
    fs.writeFileSync(file, 'original')
    const history = new FileHistory(dir)
    fs.rmSync(join(dir, 'file-history'), { recursive: true })
    fs.writeFileSync(join(dir, 'file-history'), 'blocks backup directory')
    expect(history.trackEdit(file)).toMatchObject({ status: 'failed' })
    expect(history.getSummary()).toContain('unavailable')
    expect(history.restoreOriginal(file)).toBe(false)
  })

  it('reflection preserves a failed run outcome and uses the current model and cancellation domain', async () => {
    const semantic = new SemanticMemory(directory())
    const create = vi.fn().mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ knowledge: [{ content: 'A failed build requires checking generated imports', tags: ['build'], confidence: 0.8 }] }) } }] })
    const module = new ReflectionModule({ chat: { completions: { create } } } as never, 'old-model', semantic, {})
    const controller = new AbortController()
    await module.onComplete({ cwd: process.cwd(), model: 'new-model', abortSignal: controller.signal, turnResult: { reason: 'error', status: 'failed', output: '', iterations: 1 } as never, messages: [1, 2, 3].map(index => ({ role: 'tool', tool_call_id: String(index), content: 'build failed' })) })
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0][0].model).toBe('new-model')
    expect(create.mock.calls[0][1].signal).toBe(controller.signal)
    expect(semantic.readAll()[0]).toMatchObject({ provenance: { status: 'unverified', outcome: 'failed' } })
    expect(semantic.readAll()[0].content).toContain('failed')
  })
})
