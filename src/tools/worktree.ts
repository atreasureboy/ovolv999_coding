/**
 * Worktree Tools — Git Worktree isolation for parallel agent work.
 *
 * Creates isolated working copies of the repository so multiple agents
 * can work simultaneously without stepping on each other's changes.
 *
 * Workflow:
 *   1. EnterWorktree creates a new branch + worktree at .ovolv999/worktrees/<name>
 *   2. Agent works in the isolated copy (all file operations are scoped)
 *   3. ExitWorktree merges the branch back (or discards)
 *
 * Inspired by Claude Code's worktree system (src/utils/worktree.ts, 49KB).
 * Our implementation is simpler — we use git's native worktree feature
 * and track active worktrees in a JSON metadata file.
 */

import { execFileSync } from 'child_process'
import { approvalInputDigest } from '../core/approvalBroker.js'
import { createHash, randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import type { VerificationEvidence } from '../core/outcome.js'
import { captureArtifactVersion, createVerificationPlan } from '../core/verification.js'
import { withGitResource } from '../core/gitResource.js'
import { WorktreeStore, type StoredWorktree, type StoredWorktreeAcceptance } from '../core/worktreeStore.js'

// ── Types ───────────────────────────────────────────────────────────────────

export interface WorktreeInfo {
  /** Unique name for this worktree */
  name: string
  /** Absolute path to the worktree directory */
  path: string
  /** Branch name in the worktree */
  branch: string
  /** Base branch this worktree was created from */
  baseBranch: string
  /** Creation timestamp */
  createdAt: string
  baseCommit?: string
  targetBranch?: string
  targetCommit?: string
  repositoryPath?: string
}

export interface WorktreeBinding {
  cwd: string
  repositoryPath: string
  worktreeName: string
  baseCommit: string
  targetBranch: string
  targetCommit: string
  branch: string
}

export interface WorktreeArtifact {
  workspace: WorktreeBinding
  commit: string
  diff: string
}

export type WorktreeAcceptance = VerificationEvidence

// ── Worktree Manager ────────────────────────────────────────────────────────

const WORKTREE_DIR = '.ovolv999/worktrees'

export interface ActualWorktree {
  path: string
  commit?: string
  branch?: string
  locked: boolean
  prunable: boolean
}

export interface WorktreeReconciliation {
  entries: Array<{ status: 'managed' | 'metadata_only' | 'mismatched' | 'unknown'; info?: WorktreeInfo; actual?: ActualWorktree; operation?: StoredWorktree['operation'] }>
}

export interface RemoveWorktreeOptions {
  merge?: boolean
  deleteBranch?: boolean
  discardApproved?: boolean
}

export class WorktreeManager {
  private store: WorktreeStore
  private validated = new Map<string, StoredWorktreeAcceptance>()
  private cwd: string

  constructor(cwd: string) {
    this.cwd = resolve(cwd)
    this.store = new WorktreeStore(this.cwd)
  }

  private git(args: string[], cwd = this.cwd): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }).replace(/\r?\n$/, '')
  }

  private validateWorktree(info: WorktreeInfo): void {
    const reconciled = this.reconcileWorktrees().entries.find(entry => entry.info?.name === info.name)
    if (reconciled?.status !== 'managed' || !existsSync(info.path)) throw new Error('Worktree is missing or its repository/branch changed; reconciliation is required and files were retained')
    const path = realpathSync(info.path)
    const root = realpathSync(this.worktreeBase())
    const child = relative(root, path)
    if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
      throw new Error('Worktree path is outside its managed directory; files were retained')
    }
    const common = realpathSync(this.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], path))
    const expected = realpathSync(this.git(['rev-parse', '--path-format=absolute', '--git-common-dir']))
    if (common !== expected || this.git(['symbolic-ref', '--short', 'HEAD'], path) !== info.branch) {
      throw new Error('Worktree repository or branch changed; files were retained')
    }
  }

  private worktreeBase(): string {
    return join(this.cwd, WORKTREE_DIR)
  }

  private entry(name: string): StoredWorktree | undefined {
    return this.store.snapshot().worktrees.find(entry => entry.info.name === name)
  }

  reconcileWorktrees(): WorktreeReconciliation {
    const actual = this.git(['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => {
      const fields = block.split('\0')
      const value = (prefix: string) => fields.find(field => field.startsWith(prefix))?.slice(prefix.length)
      return { path: resolve(value('worktree ') ?? ''), commit: value('HEAD '), branch: value('branch ')?.replace(/^refs\/heads\//, ''), locked: fields.some(field => field === 'locked' || field.startsWith('locked ')), prunable: fields.some(field => field === 'prunable' || field.startsWith('prunable ')) }
    })
    const entries: WorktreeReconciliation['entries'] = []
    const matched = new Set<string>([this.cwd])
    for (const entry of this.store.snapshot().worktrees) {
      const found = actual.find(tree => tree.path === resolve(entry.info.path))
      if (found) matched.add(found.path)
      const status = !found || !existsSync(entry.info.path) ? 'metadata_only' : found.branch !== entry.info.branch || (entry.info.repositoryPath && resolve(entry.info.repositoryPath) !== this.cwd) ? 'mismatched' : 'managed'
      entries.push({ status, info: entry.info, actual: found, operation: entry.operation })
    }
    for (const tree of actual) if (!matched.has(tree.path)) entries.push({ status: 'unknown', actual: tree })
    return { entries }
  }

  /** Check if we're inside a git repository */
  isGitRepo(): boolean {
    try {
      this.git(['rev-parse', '--git-dir'])
      return true
    } catch {
      return false
    }
  }

  /** Get the current branch name */
  getCurrentBranch(): string {
    try {
      return this.git(['symbolic-ref', '--short', 'HEAD'])
    } catch {
      throw new Error('A checked out target branch is required')
    }
  }

  /** Create a new worktree with an isolated branch */
  createWorktree(name: string, baseBranch?: string): WorktreeInfo {
    if (!this.isGitRepo()) {
      throw new Error('Not a git repository — worktrees require git')
    }

    return this.store.transaction((record, commit, assertOwned) => {
      if (record.worktrees.some(entry => entry.info.name === name)) {
        throw new Error(`Worktree "${name}" already exists`)
      }

      // Sanitize name for branch/directory naming
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-')
      const branch = `wt/${safeName}`
      const base = baseBranch ?? this.getCurrentBranch()
      const baseCommit = this.git(['rev-parse', '--verify', `refs/heads/${base}^{commit}`])
      const wtPath = join(this.worktreeBase(), safeName)

      // Ensure base directory exists
      mkdirSync(this.worktreeBase(), { recursive: true })

      if (existsSync(wtPath)) {
        throw new Error(`Worktree path already exists: ${wtPath}. Use a different name or remove it first.`)
      }

      const info: WorktreeInfo = {
        name,
        path: wtPath,
        branch,
        baseBranch: base,
        createdAt: new Date().toISOString(),
        baseCommit,
        targetBranch: base,
        targetCommit: baseCommit,
        repositoryPath: this.cwd,
      }
      const entry: StoredWorktree = { info, generation: randomUUID(), operation: { kind: 'create', phase: 'intent' } }
      record.worktrees.push(entry)
      commit()

      try {
        assertOwned()
        execFileSync('git', [
          'worktree', 'add',
          '-b', branch,
          wtPath,
          base,
        ], { cwd: this.cwd, stdio: 'pipe' })
      } catch (err) {
        const msg = (err as Error).message
        throw new Error(`Failed to create worktree; any partial directory was retained: ${msg}`, { cause: err })
      }

      delete entry.operation
      try {
        commit()
      } catch (error) {
        throw new Error(`Created worktree at ${wtPath} on branch ${branch}, but metadata completion failed; tree and branch were retained for recovery: ${(error as Error).message}`, { cause: error })
      }
      return { ...info }
    })
  }

  /** Get info about an existing worktree */
  getWorktree(name: string): WorktreeInfo | undefined {
    const info = this.entry(name)?.info
    return info ? { ...info } : undefined
  }

  /** List all active worktrees */
  listWorktrees(): WorktreeInfo[] {
    return this.store.snapshot().worktrees.map(entry => entry.info)
  }

  getBinding(name: string): WorktreeBinding {
    const info = this.entry(name)?.info
    if (!info) throw new Error(`Worktree "${name}" does not exist`)
    if (!info.baseCommit || !info.targetBranch || !info.targetCommit || !info.repositoryPath) {
      throw new Error('Legacy worktree has no recorded base commit or merge target; files were retained')
    }
    this.validateWorktree(info)
    return {
      cwd: info.path,
      repositoryPath: info.repositoryPath,
      worktreeName: info.name,
      baseCommit: info.baseCommit,
      targetBranch: info.targetBranch,
      targetCommit: info.targetCommit,
      branch: info.branch,
    }
  }

  getArtifact(name: string): WorktreeArtifact {
    const workspace = this.getBinding(name)
    const commit = this.git(['rev-parse', 'HEAD'], workspace.cwd)
    const hash = createHash('sha256')
    for (const args of [
      ['diff', '--binary', workspace.baseCommit, commit, '--'],
      ['diff', '--binary', 'HEAD', '--'],
      ['diff', '--binary', '--cached', '--'],
      ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    ]) {
      hash.update(this.git(args, workspace.cwd)).update('\0')
    }
    const untracked = this.git(['ls-files', '--others', '--exclude-standard', '-z'], workspace.cwd).split('\0').filter(Boolean)
    for (const path of untracked) hash.update(path).update('\0').update(readFileSync(join(workspace.cwd, path))).update('\0')
    return { workspace, commit, diff: hash.digest('hex') }
  }

  async acceptArtifact(name: string, inputEvidence: WorktreeAcceptance, artifact: WorktreeArtifact): Promise<void> {
    this.invalidateAcceptance(name)
    const generation = this.entry(name)!.generation
    const evidence = structuredClone(inputEvidence)
    if (evidence.status !== 'passed' || !evidence.runId || !evidence.artifactVersion) {
      throw new Error('Artifact acceptance requires passed verification bound to a run and artifact version')
    }
    const current = this.getArtifact(name)
    if (resolve(evidence.workspace) !== resolve(current.workspace.cwd)) {
      throw new Error('Verification workspace does not match this worktree')
    }
    if (JSON.stringify(current) !== JSON.stringify(artifact)) {
      throw new Error('Artifact changed during verification; acceptance evidence is stale')
    }
    if (!evidence.commands.length || evidence.commands.some(command => !command.passed || command.exitCode !== 0 || command.cancelled || command.timedOut)) {
      throw new Error('Artifact acceptance requires successful executed verification commands')
    }
    const plan = createVerificationPlan(current.workspace.cwd, evidence.commands.map(command => command.command))
    if (plan.definitionHash !== evidence.definitionHash) {
      throw new Error('Verification definition changed; acceptance evidence is stale')
    }
    if (await captureArtifactVersion(current.workspace.cwd) !== evidence.artifactVersion) {
      throw new Error('Verified artifact version does not match the current worktree')
    }
    if (JSON.stringify(this.getArtifact(name)) !== JSON.stringify(current)) {
      throw new Error('Artifact changed during acceptance; worktree was retained')
    }
    this.store.transaction((record, commit) => {
      const entry = record.worktrees.find(item => item.info.name === name)
      if (entry?.generation !== generation) throw new Error('Acceptance was invalidated by a newer task or verification attempt')
      const acceptance: StoredWorktreeAcceptance = { generation, definitionHash: evidence.definitionHash!, definitionContext: createVerificationPlan(current.workspace.cwd, []).definitionHash, artifactVersion: evidence.artifactVersion!, targetCommit: current.workspace.targetCommit, artifact: current }
      entry.acceptance = acceptance
      commit()
      this.validated.set(name, structuredClone(acceptance))
    })
  }

  invalidateAcceptance(name: string): void {
    this.validated.delete(name)
    this.store.transaction((record, commit) => {
      const entry = record.worktrees.find(item => item.info.name === name)
      if (!entry) throw new Error(`Worktree "${name}" does not exist`)
      entry.generation = randomUUID()
      delete entry.acceptance
      commit()
    })
  }

  /** Get diff stats between worktree branch and its base */
  getDiffStats(name: string): string {
    const info = this.entry(name)?.info
    if (!info) return ''
    try {
      const binding = this.getBinding(name)
      return [
        this.git(['diff', '--stat', binding.baseCommit, 'HEAD', '--'], binding.cwd),
        this.git(['diff', '--stat', 'HEAD', '--'], binding.cwd),
        this.git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], binding.cwd),
      ].filter(Boolean).join('\n')
    } catch {
      return ''
    }
  }

  async removeWorktreeAsync(name: string, opts: RemoveWorktreeOptions = {}): Promise<void> {
    const entry = this.entry(name)
    if (!entry) throw new Error(`Worktree "${name}" does not exist`)
    const inventory = this.reconcileWorktrees().entries.find(item => item.info?.name === name)
    const removed = entry.operation?.phase === 'removed' || entry.operation?.phase === 'removing' && !existsSync(entry.info.path) && !inventory?.actual
    if (opts.merge !== false && !removed) {
      const accepted = entry.acceptance
      const current = this.getArtifact(name)
      if (accepted) {
        if (JSON.stringify(current) !== JSON.stringify(accepted.artifact) || createVerificationPlan(current.workspace.cwd, []).definitionHash !== accepted.definitionContext || await captureArtifactVersion(current.workspace.cwd) !== accepted.artifactVersion) {
          this.invalidateAcceptance(name)
          throw new Error('Artifact or verification definition changed after acceptance; stale evidence rejected and worktree retained')
        }
        if (this.entry(name)?.generation !== accepted.generation || JSON.stringify(this.getArtifact(name)) !== JSON.stringify(current)) throw new Error('Acceptance was invalidated or artifact changed during recovery; files retained')
        this.validated.set(name, accepted)
      }
    }
    this.removeWorktree(name, opts)
  }

  removeWorktree(name: string, opts: RemoveWorktreeOptions = {}): void {
    this.store.transaction((record, commit, assertOwned) => {
      const entry = record.worktrees.find(item => item.info.name === name)
      if (!entry) throw new Error(`Worktree "${name}" does not exist`)
      const info = entry.info
      const merge = opts.merge !== false
      const operation = entry.operation
      if (operation && operation.kind !== 'create' && (operation.kind === 'merge') !== merge) throw new Error('Pending worktree operation has a different action; reconcile it before continuing')
      const inventory = this.reconcileWorktrees().entries.find(item => item.info?.name === name)
      const removed = operation?.phase === 'removed' || operation?.phase === 'removing' && inventory?.status === 'metadata_only' && !existsSync(info.path) && !inventory.actual
      if (!removed) {
        this.validateWorktree(info)
        if (merge) {
          const dirty = this.git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], info.path)
          if (dirty) throw new Error(`Worktree "${name}" has uncommitted or ignored files; worktree and changes were retained:\n${dirty}`)
          const binding = this.getBinding(name)
          if (this.getCurrentBranch() !== binding.targetBranch) throw new Error(`Merge target branch changed; expected ${binding.targetBranch}. Worktree was retained`)
          const target = this.git(['rev-parse', 'HEAD'])
          const current = this.getArtifact(name)
          let alreadyMerged = false
          if (operation?.kind === 'merge') {
            if (JSON.stringify(current) !== JSON.stringify(operation.artifact)) throw new Error('Artifact changed during pending merge cleanup; files were retained')
            try { this.git(['merge-base', '--is-ancestor', operation.commit!, `refs/heads/${binding.targetBranch}`]); alreadyMerged = true } catch { alreadyMerged = false }
            if (operation.phase !== 'intent' && !alreadyMerged) throw new Error('Previously merged commit is no longer in its target; reconciliation is required and files retained')
          }
          if (!alreadyMerged && target !== binding.targetCommit) {
            delete entry.acceptance
            entry.generation = randomUUID()
            this.validated.delete(name)
            commit()
            throw new Error('Merge target moved since worktree creation; old acceptance invalidated and worktree retained')
          }
          if (!alreadyMerged && this.git(['diff', '--name-only', 'HEAD', '--'])) throw new Error('Merge target has uncommitted changes; worktree and changes were retained')
          const accepted = entry.acceptance
          const validated = this.validated.get(name)
          if (!accepted || !validated || validated.generation !== entry.generation || JSON.stringify(validated) !== JSON.stringify(accepted)) throw new Error('Merge requires accepted verification revalidated in this process; use removeWorktreeAsync after restart. Worktree retained')
          if (JSON.stringify(current) !== JSON.stringify(accepted.artifact) || accepted.targetCommit !== binding.targetCommit || createVerificationPlan(binding.cwd, []).definitionHash !== accepted.definitionContext) {
            delete entry.acceptance
            entry.generation = randomUUID()
            this.validated.delete(name)
            commit()
            throw new Error('Artifact changed after acceptance; verification evidence is stale and worktree was retained')
          }
          if (!alreadyMerged) {
            entry.operation = { kind: 'merge', phase: 'intent', commit: current.commit, artifact: current, deleteBranch: opts.deleteBranch }
            commit()
            try { assertOwned(); this.git(['merge', '--ff-only', '--no-edit', current.commit]) } catch (error) { throw new Error(`Merge failed for branch ${info.branch}: ${(error as Error).message}`, { cause: error }) }
          }
          entry.operation = { kind: 'merge', phase: 'merged', commit: current.commit, artifact: current, deleteBranch: opts.deleteBranch ?? operation?.deleteBranch }
          commit()
          if (JSON.stringify(this.getArtifact(name)) !== JSON.stringify(current)) throw new Error('Worktree changed during merge; merged commits remain integrated, but the worktree and new files were retained')
        } else {
          if (!opts.discardApproved) throw new Error('Discard requires explicit permission; worktree and changes were retained')
          const branchCommit = this.git(['rev-parse', '--verify', `refs/heads/${info.branch}`])
          if (operation?.kind === 'discard' && branchCommit !== operation.commit) throw new Error('Worktree branch moved during pending discard; files and branch retained for reconciliation')
          entry.operation = { kind: 'discard', phase: 'intent', commit: operation?.kind === 'discard' ? operation.commit : branchCommit, deleteBranch: opts.deleteBranch ?? operation?.deleteBranch }
          commit()
        }
        entry.operation.phase = 'removing'
        commit()
        try { assertOwned(); this.git(['worktree', 'remove', ...(merge ? [] : ['--force']), info.path]) } catch (error) { throw new Error(`Failed to remove worktree; directory, branch and metadata were retained: ${(error as Error).message}`, { cause: error }) }
        entry.operation.phase = 'removed'
        commit()
      } else if (existsSync(info.path) || inventory?.actual) {
        throw new Error('A worktree reappeared after removal; files retained for reconciliation')
      }
      if (opts.deleteBranch ?? entry.operation?.deleteBranch) {
        const present = this.git(['branch', '--list', info.branch])
        if (present) {
          const branch = this.git(['rev-parse', '--verify', `refs/heads/${info.branch}`])
          if (branch !== entry.operation?.commit) throw new Error('Worktree branch moved after removal; branch retained for reconciliation')
          assertOwned()
          this.git(['branch', merge ? '-d' : '-D', info.branch])
        }
      }
      record.worktrees = record.worktrees.filter(item => item.info.name !== name)
      commit()
      this.validated.delete(name)
    })
  }

  prune(): void {
    this.reconcileWorktrees()
  }

  /** Check if a path is inside a worktree */
  isWorktreePath(path: string): boolean {
    const abs = resolve(path)
    for (const wt of this.listWorktrees()) {
      const child = relative(resolve(wt.path), abs)
      if (child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))) return true
    }
    return false
  }
}

// ── Singleton per CWD ───────────────────────────────────────────────────────

const managers = new Map<string, WorktreeManager>()

export function getWorktreeManager(cwd: string): WorktreeManager {
  const abs = resolve(cwd)
  let mgr = managers.get(abs)
  if (!mgr) {
    mgr = new WorktreeManager(abs)
    managers.set(abs, mgr)
  }
  return mgr
}

/** Reset singleton — for tests only */
export function _resetWorktreeManagersForTest(): void {
  managers.clear()
}

// ── Tool Classes ────────────────────────────────────────────────────────────

export class EnterWorktreeTool implements Tool {
  name = 'EnterWorktree'
  metadata = { readOnly: false, longRunning: false, concurrencySafe: false }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'EnterWorktree',
      description: `Create an isolated git worktree for parallel agent work. The worktree gets its own branch and working directory at .ovolv999/worktrees/<name>, so multiple agents can work simultaneously without conflicts.

## When to Use
- Dispatching parallel work to sub-agents that modify files
- Experimenting with changes you might discard
- Isolating risky refactors from the main working tree

## When NOT to Use
- For read-only investigation (just use Read/Grep/Glob directly)
- The repo is not a git repository

Creation returns a structured workspace binding. Pass the worktree name to Agent to bind its file operations, commands and verification to that directory. Use ExitWorktree to merge accepted committed work or explicitly discard.`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Unique name for this worktree (e.g. "fix-auth", "refactor-api")',
          },
          base_branch: {
            type: 'string',
            description: 'Branch to base the worktree on (default: current branch)',
          },
        },
        required: ['name'],
      },
    },
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult & { workspace?: WorktreeBinding }> {
    const name = typeof input.name === 'string' ? input.name : ''
    const baseBranch = typeof input.base_branch === 'string' ? input.base_branch : undefined

    if (!name) {
      return Promise.resolve({ content: 'Worktree name is required', isError: true })
    }

    try {
      const cwd = ctx.workspace?.repositoryPath ?? ctx.cwd
      return await withGitResource(cwd, ctx.signal, () => {
        const mgr = getWorktreeManager(cwd)
        const info = mgr.createWorktree(name, baseBranch)
        return Promise.resolve({
          content: `Created worktree "${name}"\nPath: ${info.path}\nBranch: ${info.branch} (based on ${info.baseBranch})`,
          isError: false,
          workspace: mgr.getBinding(name),
        })
      })
    } catch (err) {
      return Promise.resolve({ content: `Failed to create worktree: ${(err as Error).message}`, isError: true })
    }
  }
}

export class ExitWorktreeTool implements Tool {
  name = 'ExitWorktree'
  metadata = { readOnly: false, longRunning: false, concurrencySafe: false }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ExitWorktree',
      description: `Exit and optionally merge a worktree back to its base branch.

## Actions
- **merge** (default): Merge committed, accepted artifacts into the recorded target, then remove the clean worktree. Uncommitted files, missing or stale verification, or a moved target retain the worktree.
- **discard**: Explicitly remove the worktree and throw away all changes after a permission check

If only one worktree is active, you can omit \`name\`.`,
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'Name of the worktree to exit',
          },
          action: {
            type: 'string',
            enum: ['merge', 'discard'],
            description: 'merge = apply changes to base branch, discard = throw away (default: merge)',
          },
          delete_branch: {
            type: 'boolean',
            description: 'Delete the branch after exit (default: true)',
          },
        },
      },
    },
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const name = typeof input.name === 'string' ? input.name : ''
    const action = input.action === undefined ? 'merge' : input.action
    const deleteBranch = input.delete_branch !== false
    if (action !== 'merge' && action !== 'discard') {
      return { content: 'Invalid action: expected merge or discard', isError: true }
    }

    try {
      const mgr = getWorktreeManager(ctx.workspace?.repositoryPath ?? ctx.cwd)
      const list = mgr.listWorktrees()

      if (name && !mgr.getWorktree(name)) {
        return { content: `Worktree "${name}" not found.`, isError: true }
      }

      // No name specified — auto-resolve
      if (list.length === 0) {
        return { content: 'No active worktrees to exit.', isError: false }
      }
      if (name || list.length === 1) {
        const selected = name || list[0].name
        const diffStats = mgr.getDiffStats(selected)
        const merge = action === 'merge'
        if (!merge) {
          const permission = ctx.permissionMode === 'deny' ? 'deny'
            : ctx.permissionManager?.check(this.name, { ...input, name: selected, action }, true)
              ?? (ctx.permissionMode === 'auto' ? 'allow' : 'ask')
          if (permission === 'deny') {
            return { content: 'Discard denied; worktree and changes were retained', isError: true }
          }
          const approvalMatches = !ctx.permissionApproval || (ctx.permissionApproval.tool === this.name &&
            ctx.permissionApproval.cwd === ctx.cwd && ctx.permissionApproval.inputDigest === approvalInputDigest({ ...input, name: selected, action }))
          if (permission === 'ask' && (!ctx.permissionApproved || !approvalMatches)) {
            if (!ctx.requestPermission) {
              return { content: 'Discard needs approval; no approval channel is available. Worktree was retained', isError: true, status: 'needs_input' }
            }
            const decision = await ctx.requestPermission(this.name, { ...input, name: selected, action }, 'dangerous')
            if (!decision.approved) return { content: 'Discard denied; worktree was retained', isError: true, ...(decision.status ? { status: decision.status } : {}) }
          }
        }
        if (ctx.signal?.aborted) return { content: 'Worktree exit cancelled; changes were retained', isError: true, status: 'cancelled' }
        await withGitResource(ctx.workspace?.repositoryPath ?? ctx.cwd, ctx.signal, () => mgr.removeWorktreeAsync(selected, { merge, deleteBranch, discardApproved: !merge }))
        const verb = merge ? 'merged into base' : 'discarded'
        return {
          content: `Worktree "${selected}" ${verb}.\n${diffStats ? `Changes:\n${diffStats}` : '(no changes)'}`,
          isError: false,
        }
      }
      return {
        content: `Multiple worktrees active. Specify name:\n${list.map(w => `  ${w.name} (${w.branch})`).join('\n')}`,
        isError: false,
      }
    } catch (err) {
      return { content: `Failed to exit worktree: ${(err as Error).message}`, isError: true }
    }
  }
}

export class ListWorktreesTool implements Tool {
  name = 'ListWorktrees'
  metadata = { readOnly: true, longRunning: false, concurrencySafe: true }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'ListWorktrees',
      description: 'List all active git worktrees created by EnterWorktree.',
      parameters: { type: 'object', properties: {} },
    },
  }

  execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const mgr = getWorktreeManager(ctx.workspace?.repositoryPath ?? ctx.cwd)
    const list = mgr.listWorktrees()
    const report = mgr.isGitRepo() ? mgr.reconcileWorktrees() : { entries: [] }
    const diagnostics = report.entries.filter(entry => entry.status !== 'managed' || entry.operation).map(entry =>
      `  ${entry.status}: ${entry.info?.name ?? entry.actual?.branch ?? 'detached'} ${entry.info?.path ?? entry.actual?.path}${entry.operation ? ` (pending ${entry.operation.kind}: ${entry.operation.phase})` : ''}`,
    )
    if (list.length === 0 && !diagnostics.length) {
      return Promise.resolve({ content: 'No active worktrees.', isError: false })
    }
    const lines = list.map(w =>
      `  ${w.name.padEnd(20)} ${w.branch.padEnd(30)} ${w.path}`,
    )
    return Promise.resolve({
      content: [`Active worktrees (${list.length}):\n${lines.join('\n')}`, diagnostics.length ? `Reconciliation (files retained):\n${diagnostics.join('\n')}` : ''].filter(Boolean).join('\n'),
      isError: false,
    })
  }
}
