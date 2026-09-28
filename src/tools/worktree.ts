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
import { createHash } from 'crypto'
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import type { Tool, ToolDefinition, ToolResult, ToolContext } from '../core/types.js'
import type { VerificationEvidence } from '../core/outcome.js'
import { captureArtifactVersion, createVerificationPlan } from '../core/verification.js'
import { withGitResource } from '../core/gitResource.js'

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
const WORKTREE_META = '.ovolv999/worktrees.json'

export class WorktreeManager {
  private active: Map<string, WorktreeInfo> = new Map()
  private accepted = new Map<string, { generation: symbol; evidence?: WorktreeAcceptance; artifact?: WorktreeArtifact }>()
  private cwd: string

  constructor(cwd: string) {
    this.cwd = resolve(cwd)
    this.loadMeta()
  }

  private git(args: string[], cwd = this.cwd): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe', timeout: 30_000 }).replace(/\r?\n$/, '')
  }

  private validateWorktree(info: WorktreeInfo): void {
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

  private metaPath(): string {
    return join(this.cwd, WORKTREE_META)
  }

  private worktreeBase(): string {
    return join(this.cwd, WORKTREE_DIR)
  }

  private loadMeta(): void {
    try {
      const raw = readFileSync(this.metaPath(), 'utf8')
      const list = JSON.parse(raw) as WorktreeInfo[]
      for (const wt of list) {
        this.active.set(wt.name, wt)
      }
    } catch {
      // No metadata file — start fresh
    }
  }

  private saveMeta(): void {
    try {
      mkdirSync(join(this.cwd, '.ovolv999'), { recursive: true })
      const list = [...this.active.values()]
      writeFileSync(this.metaPath(), JSON.stringify(list, null, 2), 'utf8')
    } catch {
      // Best-effort
    }
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

    if (this.active.has(name)) {
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

    // Create the worktree with a new branch off the base
    try {
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

    this.active.set(name, info)
    this.saveMeta()
    return info
  }

  /** Get info about an existing worktree */
  getWorktree(name: string): WorktreeInfo | undefined {
    const info = this.active.get(name)
    return info ? { ...info } : undefined
  }

  /** List all active worktrees */
  listWorktrees(): WorktreeInfo[] {
    return [...this.active.values()].map(info => ({ ...info }))
  }

  getBinding(name: string): WorktreeBinding {
    const info = this.active.get(name)
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
    const generation = this.accepted.get(name)!.generation
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
    if (this.accepted.get(name)?.generation !== generation) {
      throw new Error('Acceptance was invalidated by a newer task or verification attempt')
    }
    this.accepted.set(name, { generation, evidence, artifact: current })
  }

  invalidateAcceptance(name: string): void {
    this.accepted.set(name, { generation: Symbol(name) })
  }

  /** Get diff stats between worktree branch and its base */
  getDiffStats(name: string): string {
    const info = this.active.get(name)
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

  /** Remove a worktree and optionally merge its branch */
  removeWorktree(name: string, opts: { merge?: boolean; deleteBranch?: boolean; discardApproved?: boolean } = {}): void {
    const info = this.active.get(name)
    if (!info) {
      throw new Error(`Worktree "${name}" does not exist`)
    }

    this.validateWorktree(info)
    const merge = opts.merge !== false
    if (merge) {
      const dirty = this.git(['status', '--porcelain=v1', '--untracked-files=all', '--ignored=matching'], info.path)
      if (dirty) {
        throw new Error(`Worktree "${name}" has uncommitted or ignored files; worktree and changes were retained:\n${dirty}`)
      }
      const binding = this.getBinding(name)
      if (this.getCurrentBranch() !== binding.targetBranch) {
        throw new Error(`Merge target branch changed; expected ${binding.targetBranch}. Worktree was retained`)
      }
      if (this.git(['rev-parse', 'HEAD']) !== binding.targetCommit) {
        throw new Error('Merge target moved since worktree creation; worktree and changes were retained')
      }
      if (this.git(['diff', '--name-only', 'HEAD', '--'])) {
        throw new Error('Merge target has uncommitted changes; worktree and changes were retained')
      }
      const accepted = this.accepted.get(name)
      if (!accepted?.artifact) throw new Error('Merge requires accepted verification; worktree and changes were retained')
      const current = this.getArtifact(name)
      if (JSON.stringify(current) !== JSON.stringify(accepted.artifact)) {
        this.invalidateAcceptance(name)
        throw new Error('Artifact changed after acceptance; verification evidence is stale and worktree was retained')
      }
      try {
        this.git(['merge', '--ff-only', '--no-edit', current.commit])
      } catch (err) {
        throw new Error(`Merge failed for branch ${info.branch}: ${(err as Error).message}`, { cause: err })
      }
      if (JSON.stringify(this.getArtifact(name)) !== JSON.stringify(current)) {
        this.invalidateAcceptance(name)
        throw new Error('Worktree changed during merge; merged commits remain integrated, but the worktree and new files were retained')
      }
    } else if (!opts.discardApproved) {
      throw new Error('Discard requires explicit permission; worktree and changes were retained')
    }

    // Remove the worktree directory
    try {
      this.git(['worktree', 'remove', ...(merge ? [] : ['--force']), info.path])
    } catch (err) {
      throw new Error(`Failed to remove worktree; directory, branch and metadata were retained: ${(err as Error).message}`, { cause: err })
    }

    // Optionally delete the branch
    if (opts.deleteBranch) {
      try {
        this.git(['branch', merge ? '-d' : '-D', info.branch])
      } catch { /* best-effort */ }
    }

    this.active.delete(name)
    this.accepted.delete(name)
    this.saveMeta()
  }

  /** Prune stale worktrees (git worktree prune) */
  prune(): void {
    try {
      execFileSync('git', ['worktree', 'prune'], { cwd: this.cwd, stdio: 'pipe' })
    } catch { /* best-effort */ }
  }

  /** Check if a path is inside a worktree */
  isWorktreePath(path: string): boolean {
    const abs = resolve(path)
    for (const wt of this.active.values()) {
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
          if (permission === 'ask' && !ctx.permissionApproved) {
            if (!ctx.requestPermission) {
              return { content: 'Discard needs approval; no approval channel is available. Worktree was retained', isError: true, status: 'needs_input' }
            }
            const decision = await ctx.requestPermission(this.name, { ...input, name: selected, action }, 'dangerous')
            if (!decision.approved) return { content: 'Discard denied; worktree was retained', isError: true }
          }
        }
        if (ctx.signal?.aborted) return { content: 'Worktree exit cancelled; changes were retained', isError: true, status: 'cancelled' }
        await withGitResource(ctx.workspace?.repositoryPath ?? ctx.cwd, ctx.signal, () => {
          mgr.removeWorktree(selected, { merge, deleteBranch, discardApproved: !merge })
          return Promise.resolve()
        })
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
    if (list.length === 0) {
      return Promise.resolve({ content: 'No active worktrees.', isError: false })
    }
    const lines = list.map(w =>
      `  ${w.name.padEnd(20)} ${w.branch.padEnd(30)} ${w.path}`,
    )
    return Promise.resolve({
      content: `Active worktrees (${list.length}):\n${lines.join('\n')}`,
      isError: false,
    })
  }
}
