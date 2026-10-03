import { execFile } from 'child_process'
import { promisify } from 'util'
import { hostname } from 'os'
import { captureProcessIdentity, inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'

const execute = promisify(execFile)

export interface OwnedProcessTree {
  root: ProcessIdentity
  members: ProcessIdentity[]
  detached: boolean
}

export interface TreeStopResult {
  stopped: boolean
  reason?: string
  remaining: ProcessIdentity[]
}

export class OwnedProcessTreeCaptureError extends Error {
  constructor(message: string, readonly tree: OwnedProcessTree, readonly hasUnverifiedDescendants: boolean) { super(message); this.name = 'OwnedProcessTreeCaptureError' }
}

export function mergeOwnedProcessTrees(previous: OwnedProcessTree | undefined, current: OwnedProcessTree): OwnedProcessTree {
  if (previous && (previous.root.pid !== current.root.pid || previous.root.birthId !== current.root.birthId || previous.root.hostname !== current.root.hostname)) throw new Error('Owned process root identity changed; refusing to merge its tree')
  const members = new Map((previous?.members ?? []).map(identity => [`${identity.pid}:${identity.birthId}`, identity]))
  for (const identity of current.members) members.set(`${identity.pid}:${identity.birthId}`, identity)
  return { ...current, members: [...members.values()] }
}

export function selectOwnedProcessMembers(root: ProcessIdentity, candidates: Array<{ identity: ProcessIdentity; parentPid: number }>): ProcessIdentity[] {
  const members = new Map([[root.pid, root]])
  const bornAfter = (parent: ProcessIdentity, child: ProcessIdentity): boolean => {
    const parentBirth = parent.birthId.split(':')
    const childBirth = child.birthId.split(':')
    const parentTime = parentBirth.pop()
    const childTime = childBirth.pop()
    return parentBirth.join(':') === childBirth.join(':') && /^\d+$/.test(parentTime ?? '') && /^\d+$/.test(childTime ?? '') && BigInt(childTime!) >= BigInt(parentTime!)
  }
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of candidates) {
      const parent = members.get(candidate.parentPid)
      if (parent && !members.has(candidate.identity.pid) && bornAfter(parent, candidate.identity)) {
        members.set(candidate.identity.pid, candidate.identity)
        changed = true
      }
    }
  }
  return [...members.values()]
}

export async function captureOwnedProcessTreeFromPid(pid: number, detached = process.platform !== 'win32'): Promise<OwnedProcessTree | null> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid process ID for tree discovery')
  if (process.platform !== 'win32') {
    const root = await captureProcessIdentity(pid)
    return root ? captureOwnedProcessTree(root, detached) : null
  }
  const script = `$ErrorActionPreference = 'Stop'
$rootPid = ${pid}
try { $rootBirth = [long](Get-Process -Id $rootPid).StartTime.ToUniversalTime().Ticks } catch { 'null'; exit }
$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate)
$rootRow = $rows | Where-Object { $_.ProcessId -eq $rootPid } | Select-Object -First 1
if (!$rootRow -or ([long]$rootRow.CreationDate.ToUniversalTime().Ticks) -ne ($rootBirth - ($rootBirth % 10))) { 'null'; exit }
$descendants = [System.Collections.Generic.HashSet[int]]::new()
$null = $descendants.Add($rootPid)
$rowIndex = @{}
foreach ($row in $rows) { $rowIndex[[int]$row.ProcessId] = $row }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $rows) {
    $parent = $rowIndex[[int]$row.ParentProcessId]
    if ($parent -and $row.CreationDate -ge $parent.CreationDate -and $descendants.Contains([int]$row.ParentProcessId) -and $descendants.Add([int]$row.ProcessId)) { $changed = $true }
  }
}
$members = @([pscustomobject]@{ pid = $rootPid; parentPid = 0; birthId = $rootBirth.ToString() })
$unverified = $false
foreach ($row in $rows) {
  if ($row.ProcessId -eq $rootPid -or !$descendants.Contains([int]$row.ProcessId)) { continue }
  try {
    $birth = [long](Get-Process -Id $row.ProcessId).StartTime.ToUniversalTime().Ticks
    if ([long]$row.CreationDate.ToUniversalTime().Ticks -ne ($birth - ($birth % 10))) { continue }
    $members += [pscustomobject]@{ pid = [int]$row.ProcessId; parentPid = [int]$row.ParentProcessId; birthId = $birth.ToString() }
  } catch { if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { $unverified = $true } }
}
$failure = if ($unverified) { 'A descendant birth identity could not be verified during tree discovery' } else { $null }
try { if ([long](Get-Process -Id $rootPid).StartTime.ToUniversalTime().Ticks -ne $rootBirth) { $failure = 'Root identity changed during tree discovery' } } catch { $failure = 'Root exited during tree discovery' }
[pscustomobject]@{ rootBirth = $rootBirth.ToString(); members = @($members); failure = $failure; unverified = $unverified } | ConvertTo-Json -Compress -Depth 4`
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
  const parsed = JSON.parse(stdout) as unknown
  if (parsed === null) return null
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid owned process tree snapshot')
  const value = parsed as Record<string, unknown>
  if (typeof value.rootBirth !== 'string' || !/^\d+$/.test(value.rootBirth) || !Array.isArray(value.members)) throw new Error('Invalid owned process tree snapshot')
  const root: ProcessIdentity = { pid, hostname: hostname(), birthId: value.rootBirth }
  const candidates = value.members.map((member: unknown): { identity: ProcessIdentity; parentPid: number } => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) throw new Error('Invalid owned descendant snapshot')
    const record = member as Record<string, unknown>
    if (!Number.isSafeInteger(record.pid) || Number(record.pid) < 1 || !Number.isSafeInteger(record.parentPid) || Number(record.parentPid) < 0 || typeof record.birthId !== 'string' || !/^\d+$/.test(record.birthId)) throw new Error('Invalid owned descendant snapshot')
    return { identity: { pid: Number(record.pid), hostname: root.hostname, birthId: record.birthId }, parentPid: Number(record.parentPid) }
  })
  if (!candidates.some(member => member.identity.pid === pid && member.identity.birthId === root.birthId)) throw new Error('Owned tree snapshot is missing its root identity')
  const members = selectOwnedProcessMembers(root, candidates)
  const tree = { root, members, detached }
  if (typeof value.failure === 'string') throw new OwnedProcessTreeCaptureError(value.failure, tree, value.unverified === true)
  return tree
}

export async function captureOwnedProcessTree(root: ProcessIdentity, detached = process.platform !== 'win32'): Promise<OwnedProcessTree> {
  if (process.platform === 'win32') {
    const tree = await captureOwnedProcessTreeFromPid(root.pid, detached)
    if (!tree || tree.root.birthId !== root.birthId || tree.root.hostname !== root.hostname) throw new Error('Process identity cannot be confirmed during tree discovery')
    return tree
  }
  if (await inspectProcessIdentity(root) !== 'matching') throw new Error('Process identity cannot be confirmed before tree discovery')
  const { stdout } = await execute('ps', ['-eo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
  const relationships: Array<{ pid: number; parent: number }> = stdout.trim().split('\n').map(line => {
    const [pid, parent] = line.trim().split(/\s+/).map(Number)
    return { pid, parent }
  })
  const descendants = new Set([root.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const row of relationships) if (descendants.has(row.parent) && !descendants.has(row.pid)) { descendants.add(row.pid); changed = true }
  }
  if (await inspectProcessIdentity(root) !== 'matching') throw new Error('Root exited during tree discovery; resources require recovery')
  const members: ProcessIdentity[] = [root]
  for (const pid of descendants) {
    if (pid === root.pid) continue
    const identity = await captureProcessIdentity(pid)
    if (!identity) throw new Error(`Could not verify descendant identity: ${pid}`)
    members.push(identity)
  }
  return { root, members: selectOwnedProcessMembers(root, members.filter(member => member.pid !== root.pid).map(identity => ({ identity, parentPid: relationships.find(row => row.pid === identity.pid)!.parent }))), detached }
}

async function livingMembers(tree: OwnedProcessTree): Promise<{ live: ProcessIdentity[]; unknown: boolean }> {
  const live: ProcessIdentity[] = []
  let unknown = false
  for (const identity of tree.members) {
    const state = await inspectProcessIdentity(identity)
    if (state === 'matching') live.push(identity)
    if (state === 'unknown') { unknown = true; live.push(identity) }
  }
  return { live, unknown }
}

async function signalTree(tree: OwnedProcessTree, signal: NodeJS.Signals): Promise<void> {
  const rootState = await inspectProcessIdentity(tree.root)
  if (rootState === 'unknown' || rootState === 'mismatch') throw new Error('Root process identity changed; refusing to signal its tree')
  if (process.platform === 'win32' && rootState === 'matching') {
    try {
      await execute('taskkill.exe', ['/PID', String(tree.root.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 })
    } catch (error) {
      if (signal === 'SIGKILL' && await inspectProcessIdentity(tree.root) === 'matching') throw error
    }
    return
  }
  if (process.platform !== 'win32' && tree.detached && rootState === 'matching') {
    process.kill(-tree.root.pid, signal)
    return
  }
  for (const identity of [...tree.members].reverse()) {
    if (await inspectProcessIdentity(identity) !== 'matching') continue
    try { process.kill(identity.pid, signal) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
}

export async function stopOwnedProcessTree(tree: OwnedProcessTree, graceMs = 3000, confirmationMs = 5000): Promise<TreeStopResult> {
  try {
    await signalTree(tree, 'SIGTERM')
    const graceDeadline = Date.now() + Math.max(0, graceMs)
    let state = await livingMembers(tree)
    while (state.live.length && Date.now() < graceDeadline && !state.unknown) {
      await new Promise(resolve => setTimeout(resolve, 50))
      state = await livingMembers(tree)
    }
    if (state.unknown) return { stopped: false, remaining: state.live, reason: 'Process identity could not be verified' }
    if (state.live.length) await signalTree(tree, 'SIGKILL')
    const deadline = Date.now() + confirmationMs
    state = await livingMembers(tree)
    while (state.live.length && Date.now() < deadline && !state.unknown) {
      await new Promise(resolve => setTimeout(resolve, 50))
      state = await livingMembers(tree)
    }
    return { stopped: state.live.length === 0, remaining: state.live, reason: state.live.length ? 'Process tree termination could not be confirmed' : undefined }
  } catch (error) {
    return { stopped: false, remaining: (await livingMembers(tree)).live, reason: error instanceof Error ? error.message : String(error) }
  }
}
