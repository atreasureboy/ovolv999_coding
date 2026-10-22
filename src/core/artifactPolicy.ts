import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { canonicalSessionDirectory } from './sessionManager.js'
import { RunStore } from './runStore.js'

export interface LoopArtifactPolicy {
  readonly mode: 'loop'
  readonly workspace: string
  readonly loopDir: string
  readonly sessionDir: string
  readonly budgetPath: string
  readonly runtimeRoot: string
  readonly usageRoot?: string
  readonly eventLogPath?: string
  readonly worktreeManifestPath?: string
}

const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}'
const privateTemp = `(?:\\.tmp-${uuid})?`
const durableTemp = new RegExp(`^\\.${uuid}\\.tmp$`)
const sessionTemp = '(?:\\.tmp\\.[0-9]+\\.[0-9]+\\.[a-f0-9]{16})?'
const modelWindow = new RegExp(`^agent-model-window\\.json${privateTemp}$`)
const history = new RegExp(`^history\\.json${sessionTemp}$`)
const results = new RegExp(`^agent-results/${uuid}\\.json${privateTemp}$`)
const events = new RegExp(`^agent-events/(?:manifest\\.json|snapshot\\.json|snapshot-[0-9]{16}\\.json|segment-[0-9]{16}\\.jsonl)${privateTemp}$`)
const fileHistory = new RegExp(`^file-history/(?:index\\.json${sessionTemp}|[a-f0-9]{32}/v[0-9]+_[0-9]+(?:\\.meta\\.json${sessionTemp})?)$`)
const usage = new RegExp(`^[a-f0-9]{64}/[a-f0-9]{64}(?:\\.pending)?\\.json(?:\\.${uuid}\\.tmp)?$`)
const tokenPattern = new RegExp(`^${uuid}$`)
const runName = new RegExp('^([a-zA-Z0-9][\\w-]{0,127}\\.json)(?:$|\\.)', process.platform === 'win32' ? 'i' : '')
const policies = new WeakSet<object>()

function identity(path: string): string {
  const canonical = canonicalSessionDirectory(path)
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

function metadata(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) throw new Error('Unsafe Git metadata')
  const value = readFileSync(path, 'utf8').trim()
  if (!value || /[\r\n\0]/.test(value)) throw new Error('Invalid Git metadata')
  return value
}

function mainManifest(workspace: string): string | undefined {
  let directory = workspace
  for (;;) {
    const marker = join(directory, '.git')
    let stat
    try { stat = lstatSync(marker) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    }
    if (stat) {
      try {
        if (stat.isSymbolicLink()) return undefined
        if (stat.isDirectory()) return identity(join(directory, '.ovolv999', 'worktrees.json'))
        const pointer = /^gitdir: (.+)$/.exec(metadata(marker))?.[1]
        if (!pointer) return undefined
        const gitDir = realpathSync(resolve(directory, pointer))
        const commonDir = realpathSync(resolve(gitDir, metadata(join(gitDir, 'commondir'))))
        if (pathKey(basename(commonDir)) !== '.git' || !lstatSync(commonDir).isDirectory()) return undefined
        return identity(join(dirname(commonDir), '.ovolv999', 'worktrees.json'))
      } catch { return undefined }
    }
    const parent = dirname(directory)
    if (parent === directory) return identity(join(workspace, '.ovolv999', 'worktrees.json'))
    directory = parent
  }
}

export function createLoopArtifactPolicy(input: Omit<LoopArtifactPolicy, 'mode'>): LoopArtifactPolicy {
  if (policies.has(input)) return input as LoopArtifactPolicy
  const workspace = identity(input.workspace)
  const worktreeManifestPath = mainManifest(workspace)
  const policy = Object.freeze<LoopArtifactPolicy>({
    mode: 'loop', workspace, loopDir: identity(input.loopDir),
    sessionDir: identity(input.sessionDir), budgetPath: identity(input.budgetPath), runtimeRoot: identity(input.runtimeRoot),
    ...(input.usageRoot === undefined ? {} : { usageRoot: identity(input.usageRoot) }),
    ...(input.eventLogPath === undefined ? {} : { eventLogPath: identity(input.eventLogPath) }),
    ...(worktreeManifestPath === undefined ? {} : { worktreeManifestPath }),
  })
  policies.add(policy)
  return policy
}

function within(path: string, root: string): string | undefined {
  const name = relative(root, path).replaceAll('\\', '/')
  return name === '..' || name.startsWith('../') || isAbsolute(name) ? undefined : name
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function managedName(path: string, root: string): string | undefined {
  const name = within(path, root)
  return name === undefined ? undefined : pathKey(name)
}

function lockArtifact(path: string, target: string): boolean {
  if (pathKey(path) === pathKey(target + '.lock')) return true
  const name = within(path, target + '.lock.owners')
  if (!name) return false
  const parts = name.split('/')
  if (parts.length !== 2 || !['ticket', 'ticket.tmp'].includes(pathKey(parts[1])) || !/^[A-Za-z0-9_-]+$/.test(parts[0])) return false
  try {
    const decoded = Buffer.from(parts[0], 'base64url')
    if (decoded.toString('base64url') !== parts[0]) return false
    const value = JSON.parse(decoded.toString('utf8'))
    return value && Number.isSafeInteger(value.owner?.pid) && value.owner.pid > 0
      && typeof value.owner.hostname === 'string' && value.owner.hostname.length > 0
      && typeof value.owner.birthId === 'string' && value.owner.birthId.length > 0
      && typeof value.token === 'string' && tokenPattern.test(value.token)
  } catch { return false }
}

function durableArtifact(path: string, target: string): boolean {
  return pathKey(path) === pathKey(target) || durableTemp.test(pathKey(path.slice(target.length))) && pathKey(path).startsWith(pathKey(target)) || lockArtifact(path, target)
}

function defaultLog(name: string | undefined): boolean {
  if (name === undefined) return false
  if (/^\.bg_logs\/[0-9]+_[a-zA-Z0-9._-]{0,40}_(?:[a-z0-9]{0,4}|follow)\.log$/.test(name)) return true
  const port = /^\.shell_logs\/shell_([0-9]+)\.log$/.exec(name)?.[1]
  return port !== undefined && String(Number(port)) === port && Number(port) >= 1 && Number(port) <= 65535
}

function runArtifact(path: string, policy: LoopArtifactPolicy): boolean {
  const name = within(path, join(policy.runtimeRoot, 'runs'))
  const recordName = name?.match(runName)?.[1]
  if (!recordName) return false
  const recordPath = join(policy.runtimeRoot, 'runs', recordName)
  if (!durableArtifact(path, recordPath)) return false
  try {
    if (lstatSync(recordPath).isSymbolicLink()) return false
    return identity(RunStore.inspect(realpathSync(recordPath), { deriveStatus: false }).workspace) === policy.workspace
  } catch { return false }
}

export function isLoopRuntimeArtifact(path: string, policy: LoopArtifactPolicy): boolean {
  let canonical: string
  let directory = false
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) return false
    directory = stat.isDirectory()
    canonical = canonicalSessionDirectory(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    try { canonical = canonicalSessionDirectory(path) } catch { return false }
  }
  const session = managedName(canonical, policy.sessionDir)
  if (session === 'loop-controller' || session?.startsWith('loop-controller/')) return true
  if (directory) return false
  const loop = within(canonical, policy.loopDir)
  if (loop !== undefined && ['STATE.md', 'DONE.flag', 'OUTCOME.json', 'PARKED.flag'].some(name => pathKey(name) === pathKey(loop))) return true
  if (session !== undefined && (
    history.test(session) || modelWindow.test(session) || results.test(session) || events.test(session) || fileHistory.test(session)
    || ['events.ndjson', 'events.ndjson.1', 'agent_events.ndjson'].includes(session)
    || /^tool-results\/result_[0-9]+_[a-z0-9]{0,6}\.txt$/.test(session)
    || /^task-outputs\/task_[a-f0-9]{8}\.log(?:\.1)?$/.test(session)
    || /^agent-logs\/agent-(?:0|[1-9][0-9]*)\.log$/.test(session)
  )) return true
  if (lockArtifact(canonical, join(policy.sessionDir, 'writer')) || lockArtifact(canonical, join(policy.sessionDir, 'agent-events', 'writer'))) return true
  const receipt = policy.usageRoot === undefined ? undefined : managedName(canonical, policy.usageRoot)
  if (receipt !== undefined && usage.test(receipt)) return true
  const workspace = managedName(canonical, policy.workspace)
  if (workspace === 'ovogo_progress.json' || defaultLog(workspace) || defaultLog(session)) return true
  if (durableArtifact(canonical, policy.budgetPath)) return true
  const lease = join(policy.runtimeRoot, 'workspaces', createHash('sha256').update(policy.workspace).digest('hex') + '.json')
  if (durableArtifact(canonical, lease) || runArtifact(canonical, policy)) return true
  if (policy.eventLogPath && (pathKey(canonical) === policy.eventLogPath || pathKey(canonical) === policy.eventLogPath + '.1')) return true
  return policy.worktreeManifestPath !== undefined && durableArtifact(canonical, policy.worktreeManifestPath)
}
