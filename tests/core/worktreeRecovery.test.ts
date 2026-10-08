import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { ListWorktreesTool, WorktreeManager, _resetWorktreeManagersForTest } from '../../src/tools/worktree.js'
import { createVerificationPlan, executeVerification } from '../../src/core/verification.js'
import * as runtimeState from '../../src/core/runtimeState.js'
import { captureProcessIdentitySync } from '../../src/core/processIdentity.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim()
}

async function accept(manager: WorktreeManager, name: string): Promise<void> {
  const artifact = manager.getArtifact(name)
  const cwd = artifact.workspace.cwd
  const evidence = await executeVerification({ cwd, runId: 'recovery-test', plan: createVerificationPlan(cwd, [`"${process.execPath}" -e "process.exit(0)"`]) })
  await manager.acceptArtifact(name, evidence, artifact)
}

describe('durable worktree recovery', () => {
  let cwd: string
  let meta: string
  let owner: ChildProcess | undefined

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'ovo-wt-recovery-'))
    meta = join(cwd, '.ovolv999', 'worktrees.json')
    git(cwd, 'init', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Recovery Test')
    git(cwd, 'config', 'user.email', 'recovery@example.invalid')
    git(cwd, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(cwd, '.gitignore'), '.ovolv999/\n')
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', 'base')
  })

  afterEach(() => {
    owner?.kill()
    owner = undefined
    _resetWorktreeManagersForTest()
    vi.restoreAllMocks()
    const child = relative(resolve(tmpdir()), resolve(cwd))
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !child.startsWith('ovo-wt-recovery-')) throw new Error('Unsafe test cleanup target')
    rmSync(cwd, { recursive: true, force: true })
  })

  it('reports corrupt metadata without replacing it or creating another tree', () => {
    mkdirSync(join(cwd, '.ovolv999'))
    writeFileSync(meta, '{broken')
    expect(() => new WorktreeManager(cwd)).toThrow(/corrupt|recovery/i)
    expect(readFileSync(meta, 'utf8')).toBe('{broken')
    expect(git(cwd, 'worktree', 'list', '--porcelain')).not.toContain('wt/')
  })

  it.each([
    { kind: ['merge'], phase: 'intent' },
    { kind: 'create', phase: ['intent'] },
  ])('rejects array-valued operation enums without changing metadata or files: %j', operation => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('malformed-operation')
    const record = JSON.parse(readFileSync(meta, 'utf8'))
    record.worktrees[0].operation = operation
    const raw = JSON.stringify(record)
    writeFileSync(meta, raw)
    expect(() => new WorktreeManager(cwd)).toThrow(/corrupt|recovery/i)
    expect(readFileSync(meta, 'utf8')).toBe(raw)
    expect(readFileSync(join(info.path, 'tracked.txt'), 'utf8')).toBe('base\n')
  })

  it.each([
    { kind: 'discard', phase: 'intent' },
    { kind: 'discard', phase: 'removing' },
    { kind: 'discard', phase: 'removed' },
    { kind: 'create', phase: 'removing' },
    { kind: 'create', phase: 'removed' },
    { kind: 'discard', phase: 'merged' },
  ])('retains an externally moved branch when persisted cleanup metadata is incomplete: %j', operation => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('incomplete-cleanup')
    const record = JSON.parse(readFileSync(meta, 'utf8'))
    record.worktrees[0].operation = operation.phase === 'merged' ? { ...operation, commit: info.baseCommit } : operation
    const raw = JSON.stringify(record)
    writeFileSync(meta, raw)
    git(cwd, 'worktree', 'remove', info.path)
    writeFileSync(join(cwd, 'external.txt'), 'external branch update')
    git(cwd, 'add', 'external.txt')
    git(cwd, 'commit', '-m', 'external update')
    git(cwd, 'branch', '-f', info.branch, 'HEAD')
    const moved = git(cwd, 'rev-parse', `refs/heads/${info.branch}`)
    expect(() => new WorktreeManager(cwd).removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/corrupt|recovery/i)
    expect(git(cwd, 'rev-parse', `refs/heads/${info.branch}`)).toBe(moved)
    expect(readFileSync(meta, 'utf8')).toBe(raw)
  })

  it('does not repin a discard operation after its first removal failed and the branch moved', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('discard-retry')
    git(cwd, 'worktree', 'lock', info.path)
    expect(() => manager.removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/remove|locked/i)
    writeFileSync(join(info.path, 'external.txt'), 'external branch update')
    git(info.path, 'add', 'external.txt')
    git(info.path, 'commit', '-m', 'external update')
    const moved = git(info.path, 'rev-parse', 'HEAD')
    git(cwd, 'worktree', 'unlock', info.path)
    expect(() => new WorktreeManager(cwd).removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/branch.*moved|reconcil/i)
    expect(git(cwd, 'rev-parse', `refs/heads/${info.branch}`)).toBe(moved)
    expect(readFileSync(join(info.path, 'external.txt'), 'utf8')).toBe('external branch update')
    expect(JSON.parse(readFileSync(meta, 'utf8')).worktrees[0].operation.commit).toBe(info.baseCommit)
  })

  it('rejects a merge receipt whose pinned commit differs from its retained artifact', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('inconsistent-merge-pin')
    writeFileSync(join(info.path, 'artifact.txt'), 'unmerged artifact')
    git(info.path, 'add', 'artifact.txt')
    git(info.path, 'commit', '-m', 'artifact')
    await accept(manager, info.name)
    const artifact = manager.getArtifact(info.name)
    const record = JSON.parse(readFileSync(meta, 'utf8'))
    record.worktrees[0].operation = { kind: 'merge', phase: 'merged', commit: info.baseCommit, artifact }
    const raw = JSON.stringify(record)
    writeFileSync(meta, raw)
    expect(() => new WorktreeManager(cwd)).toThrow(/corrupt|recovery/i)
    expect(readFileSync(meta, 'utf8')).toBe(raw)
    expect(readFileSync(join(info.path, 'artifact.txt'), 'utf8')).toBe('unmerged artifact')
    expect(existsSync(join(cwd, 'artifact.txt'))).toBe(false)
  })

  it('fences a stale manager before it creates a Git branch or path', () => {
    const first = new WorktreeManager(cwd)
    first.createWorktree('first')
    const stale = new WorktreeManager(cwd)
    first.createWorktree('second')
    expect(() => stale.createWorktree('stale')).toThrow(/revision|ownership/i)
    expect(existsSync(join(cwd, '.ovolv999', 'worktrees', 'stale'))).toBe(false)
    expect(git(cwd, 'branch', '--list', 'wt/stale')).toBe('')
  })

  it('reports actual unknown trees and metadata-only trees without adopting or deleting them', () => {
    const manager = new WorktreeManager(cwd)
    const known = manager.createWorktree('known')
    git(cwd, 'worktree', 'remove', known.path)
    const unknown = join(cwd, 'unknown')
    git(cwd, 'worktree', 'add', '-b', 'external', unknown)
    const report = manager.reconcileWorktrees()
    expect(report.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'metadata_only', info: expect.objectContaining({ name: 'known' }) }),
      expect.objectContaining({ status: 'unknown', actual: expect.objectContaining({ path: unknown }) }),
    ]))
    expect(manager.listWorktrees().map(info => info.name)).toEqual(['known'])
    expect(readFileSync(join(unknown, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(() => manager.removeWorktree('known', { merge: false, discardApproved: true })).toThrow(/missing|reconcil|retained/i)
  })

  it('reports mismatched branches while preserving their contents', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('mismatch')
    git(info.path, 'switch', '-c', 'external-change')
    writeFileSync(join(info.path, 'user.txt'), 'keep')
    expect(manager.reconcileWorktrees().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'mismatched', info: expect.objectContaining({ name: info.name }) }),
    ]))
    expect(() => manager.removeWorktree(info.name, { merge: false, discardApproved: true })).toThrow(/branch|reconcil|retained/i)
    expect(readFileSync(join(info.path, 'user.txt'), 'utf8')).toBe('keep')
  })

  it('rechecks persisted acceptance after restart and merges the same artifact', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('persisted')
    writeFileSync(join(info.path, 'artifact.txt'), 'accepted')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    await accept(manager, info.name)
    const restarted = new WorktreeManager(cwd)
    await restarted.removeWorktreeAsync(info.name, { merge: true })
    expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('accepted')
    expect(existsSync(info.path)).toBe(false)
  })

  it('rejects persisted acceptance after the target moves', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('target-moved')
    await accept(manager, info.name)
    writeFileSync(join(cwd, 'target.txt'), 'new target')
    git(cwd, 'add', 'target.txt')
    git(cwd, 'commit', '-m', 'target moved')
    await expect(new WorktreeManager(cwd).removeWorktreeAsync(info.name, { merge: true })).rejects.toThrow(/target.*moved/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('retries cleanup after a successful merge without merging again when target moves', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('cleanup')
    writeFileSync(join(info.path, 'artifact.txt'), 'accepted')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    await accept(manager, info.name)
    git(cwd, 'worktree', 'lock', info.path)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/remove|locked/i)
    expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('accepted')
    writeFileSync(join(cwd, 'later.txt'), 'later')
    git(cwd, 'add', 'later.txt')
    git(cwd, 'commit', '-m', 'later target')
    const target = git(cwd, 'rev-parse', 'HEAD')
    git(cwd, 'worktree', 'unlock', info.path)
    await new WorktreeManager(cwd).removeWorktreeAsync(info.name, { merge: true })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(target)
    expect(existsSync(info.path)).toBe(false)
  })

  it('imports valid legacy arrays but retains entries without a recorded merge target', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('legacy')
    const legacy = { name: info.name, path: info.path, branch: info.branch, baseBranch: info.baseBranch, createdAt: info.createdAt }
    writeFileSync(meta, JSON.stringify([legacy]))
    const restarted = new WorktreeManager(cwd)
    expect(restarted.getWorktree(info.name)).toMatchObject({ name: 'legacy' })
    expect(() => restarted.removeWorktree(info.name, { merge: true })).toThrow(/legacy|target|base/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('retains and reports a real tree when metadata completion fails after creation', async () => {
    const manager = new WorktreeManager(cwd)
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      const record = value as { worktrees: Array<{ operation?: unknown }> }
      if (path === meta && record.worktrees.length && !record.worktrees[0].operation) throw new Error('Injected disk failure')
      write(path, value, exclusive)
    })
    expect(() => manager.createWorktree('metadata-failed')).toThrow(/metadata.*failed.*retained/i)
    const path = join(cwd, '.ovolv999', 'worktrees', 'metadata-failed')
    expect(readFileSync(join(path, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(new WorktreeManager(cwd).reconcileWorktrees().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'managed', actual: expect.objectContaining({ path }), operation: { kind: 'create', phase: 'intent' } }),
    ]))
    expect((await new ListWorktreesTool().execute({}, { cwd, permissionMode: 'auto' })).content).toContain('metadata-failed')
  })

  it('lists actual unknown trees even when there is no managed metadata', async () => {
    const path = join(cwd, 'outside-manager')
    git(cwd, 'worktree', 'add', '-b', 'external', path)
    const result = await new ListWorktreesTool().execute({}, { cwd, permissionMode: 'auto' })
    expect(result.content).toMatch(/unknown/i)
    expect(result.content).toContain(path)
    expect(existsSync(join(path, 'tracked.txt'))).toBe(true)
    expect(existsSync(meta)).toBe(false)
  })

  it('does not steal metadata from a verified live process owner', () => {
    const manager = new WorktreeManager(cwd)
    manager.createWorktree('owned')
    owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
    if (!owner.pid) throw new Error('Test owner process did not start')
    const identity = captureProcessIdentitySync(owner.pid)
    expect(identity).not.toBeNull()
    const data = JSON.parse(readFileSync(meta, 'utf8'))
    data.owner = identity
    writeFileSync(meta, JSON.stringify(data))
    expect(() => new WorktreeManager(cwd).createWorktree('stolen')).toThrow(/live|owner/i)
    expect(git(cwd, 'branch', '--list', 'wt/stolen')).toBe('')
    expect(JSON.parse(readFileSync(meta, 'utf8')).owner).toEqual(identity)
  })

  it('does not trust synchronous persisted acceptance until the artifact scan is revalidated', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('sync-restart')
    await accept(manager, info.name)
    expect(() => new WorktreeManager(cwd).removeWorktree(info.name, { merge: true })).toThrow(/revalid|async/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('rejects persisted acceptance when an ignored verification definition changes content', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('definition')
    writeFileSync(join(info.path, '.gitignore'), '.ovolv999/\npackage.json\n')
    git(info.path, 'add', '.gitignore')
    git(info.path, 'commit', '-m', 'ignore local config')
    writeFileSync(join(info.path, 'package.json'), '{"scripts":{"test":"before"}}')
    await accept(manager, info.name)
    writeFileSync(join(info.path, 'package.json'), '{"scripts":{"test":"after"}}')
    await expect(new WorktreeManager(cwd).removeWorktreeAsync(info.name, { merge: true })).rejects.toThrow(/definition|stale|artifact/i)
    expect(readFileSync(join(info.path, 'package.json'), 'utf8')).toContain('after')
  })

  it('recognizes a merged commit when the durable merge receipt failed', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('missing-merge-receipt')
    writeFileSync(join(info.path, 'artifact.txt'), 'accepted')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    await accept(manager, info.name)
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      const record = value as { worktrees: Array<{ operation?: { phase: string } }> }
      if (path === meta && record.worktrees[0]?.operation?.phase === 'merged') throw new Error('Injected merge receipt failure')
      write(path, value, exclusive)
    })
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/receipt failure/i)
    expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('accepted')
    vi.restoreAllMocks()
    writeFileSync(join(cwd, 'later.txt'), 'later')
    git(cwd, 'add', 'later.txt')
    git(cwd, 'commit', '-m', 'target advanced')
    const target = git(cwd, 'rev-parse', 'HEAD')
    await new WorktreeManager(cwd).removeWorktreeAsync(info.name, { merge: true })
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(target)
    expect(existsSync(info.path)).toBe(false)
  })

  it('finishes metadata cleanup after a removed tree lost its durable receipt', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('missing-remove-receipt')
    await accept(manager, info.name)
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      const record = value as { worktrees: Array<{ operation?: { phase: string } }> }
      if (path === meta && record.worktrees[0]?.operation?.phase === 'removed') throw new Error('Injected remove receipt failure')
      write(path, value, exclusive)
    })
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/receipt failure/i)
    expect(existsSync(info.path)).toBe(false)
    vi.restoreAllMocks()
    const restarted = new WorktreeManager(cwd)
    await restarted.removeWorktreeAsync(info.name, { merge: true })
    expect(restarted.getWorktree(info.name)).toBeUndefined()
  })

  it('fences an epoch changed by another writer before the next native mutation', () => {
    const manager = new WorktreeManager(cwd)
    manager.createWorktree('epoch')
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      write(path, value, exclusive)
      const record = value as { epoch: string; worktrees: Array<{ info: { name: string } }> }
      if (record.worktrees.some(entry => entry.info.name === 'blocked')) writeFileSync(path, JSON.stringify({ ...record, epoch: 'new-owner-epoch' }))
    })
    expect(() => manager.createWorktree('blocked')).toThrow(/epoch|ownership|revision/i)
    expect(git(cwd, 'branch', '--list', 'wt/blocked')).toBe('')
    expect(existsSync(join(cwd, '.ovolv999', 'worktrees', 'blocked'))).toBe(false)
  })

  it('does not reuse acceptance after observing a moved target that is later restored', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('target-restored')
    await accept(manager, info.name)
    writeFileSync(join(cwd, 'target.txt'), 'moved')
    git(cwd, 'add', 'target.txt')
    git(cwd, 'commit', '-m', 'move target')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/target.*moved/i)
    git(cwd, 'reset', '--hard', info.targetCommit!)
    await expect(new WorktreeManager(cwd).removeWorktreeAsync(info.name, { merge: true })).rejects.toThrow(/accept|verif/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('retains a branch moved after a discarded tree was removed', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('discard-branch')
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      const record = value as { worktrees: Array<{ operation?: { phase: string } }> }
      if (path === meta && record.worktrees[0]?.operation?.phase === 'removed') throw new Error('Injected removed receipt failure')
      write(path, value, exclusive)
    })
    expect(() => manager.removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/receipt failure/i)
    vi.restoreAllMocks()
    writeFileSync(join(cwd, 'external.txt'), 'external branch change')
    git(cwd, 'add', 'external.txt')
    git(cwd, 'commit', '-m', 'external commit')
    git(cwd, 'branch', '-f', info.branch, 'HEAD')
    const target = git(cwd, 'rev-parse', `refs/heads/${info.branch}`)
    expect(() => new WorktreeManager(cwd).removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/branch.*moved|reconcil/i)
    expect(git(cwd, 'rev-parse', `refs/heads/${info.branch}`)).toBe(target)
  })

  it('finishes metadata cleanup when branch deletion succeeded before the last write failed', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('deleted-branch')
    const write = runtimeState.durableWrite
    vi.spyOn(runtimeState, 'durableWrite').mockImplementation((path, value, exclusive) => {
      const record = value as { worktrees: unknown[] }
      if (path === meta && !record.worktrees.length) throw new Error('Injected final cleanup failure')
      write(path, value, exclusive)
    })
    expect(() => manager.removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })).toThrow(/cleanup failure/i)
    expect(existsSync(info.path)).toBe(false)
    expect(git(cwd, 'branch', '--list', info.branch)).toBe('')
    vi.restoreAllMocks()
    const restarted = new WorktreeManager(cwd)
    restarted.removeWorktree(info.name, { merge: false, discardApproved: true, deleteBranch: true })
    expect(restarted.getWorktree(info.name)).toBeUndefined()
  })

  it('recovers known trees from a process that exits immediately after creation', () => {
    const module = pathToFileURL(resolve('src/tools/worktree.ts')).href
    const loader = `import { readFile } from 'node:fs/promises';import { stripTypeScriptTypes } from 'node:module';export async function resolve(specifier, context, next) {try {return await next(specifier, context)} catch(error) {if(specifier.startsWith('.') && specifier.endsWith('.js')) return next(specifier.slice(0,-3)+'.ts', context);throw error}}export async function load(url, context, next) {if(url.endsWith('.ts')) return {format:'module',source:stripTypeScriptTypes(await readFile(new URL(url),'utf8'),{mode:'transform'}),shortCircuit:true};return next(url,context)}`
    const script = `import { register } from 'node:module';register(${JSON.stringify('data:text/javascript,' + encodeURIComponent(loader))});const { WorktreeManager } = await import(${JSON.stringify(module)});new WorktreeManager(${JSON.stringify(cwd)}).createWorktree('crashed');process.exit(67)`
    let exit: number | null = null
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe', windowsHide: true, timeout: 10000 })
    } catch (error) {
      const result = error as Error & { status: number | null; stderr: Buffer }
      if (result.status !== 67) throw new Error(result.stderr.toString(), { cause: error })
      exit = result.status
    }
    expect(exit).toBe(67)
    const before = JSON.parse(readFileSync(meta, 'utf8'))
    expect(before.owner.pid).not.toBe(process.pid)
    const restarted = new WorktreeManager(cwd)
    expect(restarted.reconcileWorktrees().entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'managed', info: expect.objectContaining({ name: 'crashed' }) }),
    ]))
    restarted.invalidateAcceptance('crashed')
    const after = JSON.parse(readFileSync(meta, 'utf8'))
    expect(after.owner.pid).toBe(process.pid)
    expect(after.epoch).not.toBe(before.epoch)
    expect(readFileSync(join(cwd, '.ovolv999', 'worktrees', 'crashed', 'tracked.txt'), 'utf8')).toBe('base\n')
  })
})
