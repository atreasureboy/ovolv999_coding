import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EnterWorktreeTool, ExitWorktreeTool, WorktreeManager, _resetWorktreeManagersForTest, getWorktreeManager } from '../src/tools/worktree.js'
import { PermissionManager } from '../src/core/permissionSystem.js'
import { createVerificationPlan, executeVerification } from '../src/core/verification.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function verify(cwd: string) {
  return executeVerification({
    cwd,
    runId: 'test-run',
    plan: createVerificationPlan(cwd, [`"${process.execPath}" -e "process.exit(0)"`]),
  })
}

async function accept(manager: WorktreeManager, name: string, artifact = manager.getArtifact(name)): Promise<void> {
  await manager.acceptArtifact(name, await verify(artifact.workspace.cwd), artifact)
}

describe('worktree data preservation', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'worktree-safety-'))
    git(cwd, 'init', '-b', 'main')
    git(cwd, 'config', 'user.name', 'Worktree Test')
    git(cwd, 'config', 'user.email', 'worktree@example.test')
    git(cwd, 'config', 'core.autocrlf', 'false')
    writeFileSync(join(cwd, 'tracked.txt'), 'base\n')
    writeFileSync(join(cwd, '.gitignore'), '.ovolv999/\n')
    git(cwd, 'add', '.')
    git(cwd, 'commit', '-m', 'initial')
  })

  afterEach(() => {
    _resetWorktreeManagersForTest()
    rmSync(cwd, { recursive: true, force: true })
  })

  it.each(['unstaged', 'staged', 'untracked'])('retains %s files when merge is requested', kind => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree(kind)
    const file = kind === 'untracked' ? 'new.txt' : 'tracked.txt'
    writeFileSync(join(info.path, file), 'irreplaceable user data\n')
    if (kind === 'staged') git(info.path, 'add', file)
    expect(() => manager.removeWorktree(kind, { merge: true, deleteBranch: true })).toThrow(/uncommitted|dirty/i)
    expect(readFileSync(join(info.path, file), 'utf8')).toBe('irreplaceable user data\n')
    expect(git(cwd, 'show', 'HEAD:tracked.txt')).toBe('base')
    expect(manager.getWorktree(kind)).toBeDefined()
    expect(git(info.path, 'status', '--porcelain')).not.toBe('')
  })

  it('rejects an unknown action without deleting files or metadata', async () => {
    const manager = getWorktreeManager(cwd)
    const info = manager.createWorktree('unknown')
    writeFileSync(join(info.path, 'new.txt'), 'keep')
    const result = await new ExitWorktreeTool().execute({ name: 'unknown', action: 'merg' }, { cwd, permissionMode: 'auto' })
    expect(result.isError).toBe(true)
    expect(readFileSync(join(info.path, 'new.txt'), 'utf8')).toBe('keep')
    expect(manager.getWorktree('unknown')).toBeDefined()
  })

  it.each(['deny', 'ask'] as const)('does not discard without permission in %s mode', async permissionMode => {
    const info = getWorktreeManager(cwd).createWorktree('protected')
    writeFileSync(join(info.path, 'new.txt'), 'keep')
    const result = await new ExitWorktreeTool().execute({ action: 'discard' }, { cwd, permissionMode })
    expect(result.isError).toBe(true)
    expect(readFileSync(join(info.path, 'new.txt'), 'utf8')).toBe('keep')
  })

  it('retains the worktree when the currently checked out target branch changed', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('different-target')
    writeFileSync(join(info.path, 'artifact.txt'), 'artifact')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    git(cwd, 'checkout', '-b', 'other-target')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/target|branch/i)
    expect(existsSync(info.path)).toBe(true)
    expect(existsSync(join(cwd, 'artifact.txt'))).toBe(false)
  })

  it('retains the worktree when the original target commit moved', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('moved-target')
    writeFileSync(join(cwd, 'target.txt'), 'moved')
    git(cwd, 'add', 'target.txt')
    git(cwd, 'commit', '-m', 'move target')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/target.*moved/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('does not recursively delete or forget a worktree when Git refuses removal', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('locked')
    git(cwd, 'worktree', 'lock', '--reason', 'external owner', info.path)
    expect(() => manager.removeWorktree(info.name, { merge: false, discardApproved: true })).toThrow(/remove|locked/i)
    expect(readFileSync(join(info.path, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(manager.getWorktree(info.name)).toBeDefined()
    expect(new WorktreeManager(cwd).getWorktree(info.name)).toBeDefined()
  })

  it('rejects merging committed artifacts without acceptance', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('unverified')
    writeFileSync(join(info.path, 'artifact.txt'), 'artifact')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/accept|verif/i)
    expect(existsSync(info.path)).toBe(true)
    expect(existsSync(join(cwd, 'artifact.txt'))).toBe(false)
  })

  it('merges only accepted committed artifacts into the recorded target', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('accepted')
    writeFileSync(join(info.path, 'artifact.txt'), 'accepted artifact')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    const artifact = manager.getArtifact(info.name)
    await accept(manager, info.name, artifact)
    manager.removeWorktree(info.name, { merge: true, deleteBranch: true })
    expect(readFileSync(join(cwd, 'artifact.txt'), 'utf8')).toBe('accepted artifact')
    expect(existsSync(info.path)).toBe(false)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(artifact.commit)
  })

  it('refuses a newer commit after acceptance and retains all files', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('stale')
    const artifact = manager.getArtifact(info.name)
    await accept(manager, info.name, artifact)
    writeFileSync(join(info.path, 'artifact.txt'), 'new unverified artifact')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'new artifact')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/stale|changed|expired/i)
    expect(readFileSync(join(info.path, 'artifact.txt'), 'utf8')).toBe('new unverified artifact')
  })

  it.each(['failed', 'not_run', 'not_applicable'] as const)('does not accept %s verification', async status => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('rejected')
    await expect(manager.acceptArtifact(info.name, { ...await verify(info.path), status }, manager.getArtifact(info.name))).rejects.toThrow(/verif|accept/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('rejects acceptance for another workspace', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('wrong-workspace')
    await expect(manager.acceptArtifact(info.name, { ...await verify(info.path), workspace: cwd }, manager.getArtifact(info.name))).rejects.toThrow(/workspace/i)
  })

  it('returns a usable structured workspace binding when entering a worktree', async () => {
    const result = await new EnterWorktreeTool().execute({ name: 'bound' }, { cwd, permissionMode: 'auto' })
    expect(result.workspace?.worktreeName).toBe('bound')
    expect(result.workspace?.repositoryPath).toBe(cwd)
    expect(git(result.workspace!.cwd, 'branch', '--show-current')).toBe('wt/bound')
  })

  it('honors an explicit discard deny even when raw mode is auto', async () => {
    const manager = getWorktreeManager(cwd)
    const info = manager.createWorktree('deny-rule')
    const permissionManager = new PermissionManager()
    permissionManager.setMode('bypassPermissions')
    permissionManager.addRule({ toolName: 'ExitWorktree', ruleContent: '*', behavior: 'deny', source: 'user' })
    const result = await new ExitWorktreeTool().execute({ action: 'discard' }, { cwd, permissionMode: 'auto', permissionManager })
    expect(result.isError).toBe(true)
    expect(existsSync(info.path)).toBe(true)
  })

  it('discards dirty work only after an explicit permission grant', async () => {
    const info = getWorktreeManager(cwd).createWorktree('approved')
    writeFileSync(join(info.path, 'new.txt'), 'explicitly discarded')
    const result = await new ExitWorktreeTool().execute({ action: 'discard' }, { cwd, permissionMode: 'ask', requestPermission: () => Promise.resolve({ approved: true }) })
    expect(result.isError).toBe(false)
    expect(existsSync(info.path)).toBe(false)
  })

  it('retains ignored files instead of allowing Git removal to delete them', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('ignored')
    writeFileSync(join(info.path, '.git', '..', 'ignored.tmp'), 'keep')
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'ignored.tmp\n')
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/ignored/i)
    expect(readFileSync(join(info.path, 'ignored.tmp'), 'utf8')).toBe('keep')
  })

  it('retains the source files and branch when histories contain conflicting changes', async () => {
    const original = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'tracked.txt'), 'target version\n')
    git(cwd, 'add', 'tracked.txt')
    git(cwd, 'commit', '-m', 'target update')
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('conflict')
    git(info.path, 'switch', '-C', info.branch, original)
    writeFileSync(join(info.path, 'tracked.txt'), 'source version\n')
    git(info.path, 'add', 'tracked.txt')
    git(info.path, 'commit', '-m', 'source update')
    await accept(manager, info.name)
    expect(() => manager.removeWorktree(info.name, { merge: true, deleteBranch: true })).toThrow(/Merge failed/i)
    expect(readFileSync(join(info.path, 'tracked.txt'), 'utf8')).toBe('source version\n')
    expect(git(cwd, 'status', '--porcelain')).toBe('')
    expect(readFileSync(join(cwd, 'tracked.txt'), 'utf8')).toBe('target version\n')
    expect(manager.getWorktree(info.name)).toBeDefined()
    expect(git(cwd, 'show', `${info.branch}:tracked.txt`)).toBe('source version')
  })

  it('rejects edits made while verification was running', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('during-verification')
    writeFileSync(join(info.path, 'new.txt'), 'before')
    const artifact = manager.getArtifact(info.name)
    writeFileSync(join(info.path, 'new.txt'), 'after')
    await expect(accept(manager, info.name, artifact)).rejects.toThrow(/changed|stale/i)
    expect(readFileSync(join(info.path, 'new.txt'), 'utf8')).toBe('after')
  })

  it('does not trust persisted metadata as acceptance after restarting', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('restart')
    await accept(manager, info.name)
    expect(() => new WorktreeManager(cwd).removeWorktree(info.name, { merge: true })).toThrow(/verif|accept/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('revokes a previous acceptance when later verification fails', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('revoked')
    const artifact = manager.getArtifact(info.name)
    await accept(manager, info.name, artifact)
    await expect(manager.acceptArtifact(info.name, { ...await verify(info.path), status: 'failed' }, artifact)).rejects.toThrow(/verif|accept/i)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/verif|accept/i)
  })

  it('never interprets an omitted merge flag as permission to discard', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('default')
    writeFileSync(join(info.path, 'new.txt'), 'keep')
    expect(() => manager.removeWorktree(info.name)).toThrow(/uncommitted|dirty/i)
    expect(readFileSync(join(info.path, 'new.txt'), 'utf8')).toBe('keep')
  })

  it('retains files created by a merge hook before cleanup', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('late-file')
    writeFileSync(join(info.path, 'artifact.txt'), 'accepted')
    git(info.path, 'add', '.')
    git(info.path, 'commit', '-m', 'artifact')
    writeFileSync(join(cwd, '.git', 'info', 'exclude'), 'late.tmp\n')
    const hook = join(cwd, '.git', 'hooks', 'post-merge')
    const latePath = join(info.path, 'late.tmp').replace(/\\/g, '/').replace(/'/g, "'\\''")
    writeFileSync(hook, `#!/bin/sh\nprintf 'late user data' > '${latePath}'\n`)
    chmodSync(hook, 0o755)
    await accept(manager, info.name)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/changed|dirty|uncommitted/i)
    expect(readFileSync(join(info.path, 'late.tmp'), 'utf8')).toBe('late user data')
    expect(manager.getWorktree(info.name)).toBeDefined()
  })

  it('requires fresh acceptance after a new task invalidates the old result', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('new-task')
    await accept(manager, info.name)
    manager.invalidateAcceptance(info.name)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/verif|accept/i)
    expect(existsSync(info.path)).toBe(true)
  })

  it('uses parent repository metadata from a bound child workspace', async () => {
    const manager = getWorktreeManager(cwd)
    const info = manager.createWorktree('child')
    const result = await new ExitWorktreeTool().execute({ name: 'child', action: 'discard' }, {
      cwd: info.path, workspace: manager.getBinding(info.name), permissionMode: 'auto',
    })
    expect(result.isError).toBe(false)
    expect(existsSync(info.path)).toBe(false)
  })

  it('honors the engine approval for this discard without asking a second time', async () => {
    const info = getWorktreeManager(cwd).createWorktree('engine-approved')
    const result = await new ExitWorktreeTool().execute({ action: 'discard' }, {
      cwd, permissionMode: 'ask', permissionApproved: true,
    })
    expect(result.isError).toBe(false)
    expect(existsSync(info.path)).toBe(false)
  })

  it('includes uncommitted artifacts in the discard result', async () => {
    const info = getWorktreeManager(cwd).createWorktree('discard-summary')
    writeFileSync(join(info.path, 'new.txt'), 'discarded artifact')
    const result = await new ExitWorktreeTool().execute({ action: 'discard' }, { cwd, permissionMode: 'auto' })
    expect(result.content).toContain('new.txt')
    expect(result.isError).toBe(false)
  })

  it('captures an artifact whose untracked filename begins with whitespace', () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('whitespace')
    writeFileSync(join(info.path, ' leading.txt'), 'artifact')
    expect(() => manager.getArtifact(info.name)).not.toThrow()
  })

  it('retains divergent branches instead of creating an unverified merge commit', async () => {
    const original = git(cwd, 'rev-parse', 'HEAD')
    writeFileSync(join(cwd, 'target.txt'), 'target artifact')
    git(cwd, 'add', 'target.txt')
    git(cwd, 'commit', '-m', 'target update')
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('diverged')
    git(info.path, 'switch', '-C', info.branch, original)
    writeFileSync(join(info.path, 'source.txt'), 'verified source')
    git(info.path, 'add', 'source.txt')
    git(info.path, 'commit', '-m', 'source update')
    await accept(manager, info.name)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/Merge failed/i)
    expect(git(cwd, 'rev-parse', 'HEAD')).toBe(info.targetCommit)
    expect(readFileSync(join(info.path, 'source.txt'), 'utf8')).toBe('verified source')
    expect(existsSync(join(cwd, 'source.txt'))).toBe(false)
  })

  it('rejects verification with a forged artifact version', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('forged-version')
    const artifact = manager.getArtifact(info.name)
    const plan = createVerificationPlan(info.path, [`"${process.execPath}" -e "process.exit(0)"`])
    const evidence = await executeVerification({ cwd: info.path, runId: 'test-run', plan })
    evidence.artifactVersion = 'forged-version'
    await expect(Promise.resolve().then(() => manager.acceptArtifact(info.name, evidence, artifact))).rejects.toThrow(/artifact|version/i)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/verif|accept/i)
  })

  it('does not publish a late acceptance after a new task invalidates it', async () => {
    const manager = new WorktreeManager(cwd)
    const info = manager.createWorktree('late-acceptance')
    const artifact = manager.getArtifact(info.name)
    const evidence = await verify(info.path)
    const pending = manager.acceptArtifact(info.name, evidence, artifact)
    manager.invalidateAcceptance(info.name)
    await expect(pending).rejects.toThrow(/superseded|invalidated/i)
    expect(() => manager.removeWorktree(info.name, { merge: true })).toThrow(/verif|accept/i)
  })
})
