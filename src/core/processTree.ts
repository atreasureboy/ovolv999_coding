import { execFile } from 'child_process'
import { promisify } from 'util'
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

export async function captureOwnedProcessTree(root: ProcessIdentity, detached = process.platform !== 'win32'): Promise<OwnedProcessTree> {
  if (await inspectProcessIdentity(root) !== 'matching') throw new Error('Process identity cannot be confirmed before tree discovery')
  let relationships: Array<{ pid: number; parent: number }>
  if (process.platform === 'win32') {
    const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'], { windowsHide: true, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 })
    const parsed = JSON.parse(stdout) as Array<{ ProcessId: number; ParentProcessId: number }>
    relationships = parsed.map(row => ({ pid: row.ProcessId, parent: row.ParentProcessId }))
  } else {
    const { stdout } = await execute('ps', ['-eo', 'pid=,ppid='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 })
    relationships = stdout.trim().split('\n').map(line => {
      const [pid, parent] = line.trim().split(/\s+/).map(Number)
      return { pid, parent }
    })
  }
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
  return { root, members, detached }
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
