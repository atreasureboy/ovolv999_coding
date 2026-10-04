import { appendFileSync, existsSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { spawnManaged } from './executionBackend.js'
import type { ExecutionPolicy } from './executionPolicy.js'
import { captureProcessIdentity, inspectProcessIdentity } from './processIdentity.js'
import { captureOwnedProcessTree, stopOwnedProcessTree, type OwnedProcessTree } from './processTree.js'
import { getExitPath, getLogPath, loadMetadata, updateMetadataAsync, type SessionStatus } from './backgroundSession.js'

interface LaunchRequest {
  id: string
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
  env: NodeJS.ProcessEnv
  executionPolicy: ExecutionPolicy
}

function notify(message: object): void {
  if (process.connected) process.send?.(message, () => {})
}

async function supervise(request: LaunchRequest): Promise<void> {
  const identity = await captureProcessIdentity()
  if (!identity) throw new Error('Supervisor process identity unavailable')
  await updateMetadataAsync(request.id, { supervisorIdentity: identity })
  const child = spawnManaged(request.executable, request.args, {
    cwd: request.cwd,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...request.env, OVOGV999_SESSION_ID: request.id, OVOGV999_SUPERVISED: '1' },
    policy: request.executionPolicy,
  })
  let exited = false
  let closed = false
  let exitCode: number | null = null
  let ready = false
  let readyRequested = false
  let startupError: Error | undefined
  let ioError: Error | undefined
  const logPath = getLogPath(request.id)
  const limit = 10 * 1024 * 1024
  const append = (data: Buffer): void => {
    try {
      for (let position = 0; position < data.length; position += 64 * 1024) {
        const chunk = data.subarray(position, position + 64 * 1024)
        if (existsSync(logPath) && statSync(logPath).size + chunk.length > limit) {
          if (existsSync(`${logPath}.1`)) unlinkSync(`${logPath}.1`)
          renameSync(logPath, `${logPath}.1`)
        }
        appendFileSync(logPath, chunk, { mode: 0o600 })
      }
    } catch (error) { ioError = error instanceof Error ? error : new Error(String(error)) }
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.on('message', (message: unknown) => { if ((message as { type?: string }).type === 'ovogo:ready') readyRequested = true })
  child.once('error', error => { startupError = error })
  child.once('exit', (code) => { exited = true; exitCode = code })
  child.once('close', () => { closed = true })
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const worker = child.pid ? await captureProcessIdentity(child.pid) : null
  if (!worker) {
    child.kill('SIGKILL')
    throw new Error('Worker exited before its process identity could be verified')
  }
  const tree: OwnedProcessTree = { root: worker, members: [worker], detached: process.platform !== 'win32' }
  await updateMetadataAsync(request.id, { pid: worker.pid, processIdentity: worker })
  const deadline = Date.now() + request.timeoutMs
  let lastDiscovery = 0
  for (;;) {
    const meta = loadMetadata(request.id)
    if (!meta) throw new Error('Background metadata disappeared; recovery required')
    if (startupError) throw startupError
    if (!exited && Date.now() - lastDiscovery > 1000) {
      try {
        const snapshot = await captureOwnedProcessTree(worker, tree.detached)
        const known = new Map(tree.members.map(member => [`${member.pid}:${member.birthId}`, member]))
        for (const member of snapshot.members) known.set(`${member.pid}:${member.birthId}`, member)
        tree.members = [...known.values()]
        lastDiscovery = Date.now()
      } catch (error) {
        if (await inspectProcessIdentity(worker) === 'matching') throw error
      }
    }
    if (readyRequested && !ready && !exited) {
      ready = true
      await updateMetadataAsync(request.id, { status: 'running' })
      notify({ type: 'ready', pid: worker.pid })
    }
    const timedOut = !ready && Date.now() >= deadline
    const stopRequested = !!meta.stopRequestedAt || timedOut || !!ioError
    if (stopRequested || exited) {
      if (stopRequested) await updateMetadataAsync(request.id, { status: 'stopping' })
      const stopped = await stopOwnedProcessTree(tree, stopRequested ? meta.stopGraceMs ?? 3000 : 0)
      if (!stopped.stopped) {
        await updateMetadataAsync(request.id, { status: 'stop_failed', diagnostic: stopped.reason })
        notify({ type: 'error', error: stopped.reason })
        return
      }
      const drainDeadline = Date.now() + 5000
      while (!closed && Date.now() < drainDeadline) await new Promise(resolve => setTimeout(resolve, 25))
      if (!closed) {
        const diagnostic = 'Worker output handles remain open after termination; descendant resources require recovery'
        await updateMetadataAsync(request.id, { status: 'stop_failed', diagnostic })
        notify({ type: 'error', error: diagnostic })
        return
      }
      if (timedOut || ioError || (!ready && exited)) {
        const diagnostic = ioError ? `Background log persistence failed: ${ioError.message}` : timedOut ? 'Worker ready handshake timed out' : `Worker exited before ready (exit ${exitCode})`
        await updateMetadataAsync(request.id, { status: 'failed', endedAt: new Date().toISOString(), diagnostic, exitCode: exitCode ?? 1 })
        notify({ type: 'error', error: diagnostic })
        return
      }
      const final = loadMetadata(request.id)!
      const status: SessionStatus = stopRequested ? 'cancelled' : exitCode === 0 ? final.outcome ?? 'unknown' : final.outcome && final.outcome !== 'completed' ? final.outcome : exitCode === 124 ? 'limit_reached' : exitCode === 2 ? 'blocked' : 'failed'
      writeFileSync(getExitPath(request.id), `${exitCode ?? 130}\n`, { mode: 0o600 })
      await updateMetadataAsync(request.id, { status, outcome: stopRequested ? 'cancelled' : final.outcome, exitCode: exitCode ?? 130, endedAt: new Date().toISOString() })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

process.once('message', (request: LaunchRequest) => {
  void supervise(request).catch(async error => {
    const diagnostic = error instanceof Error ? error.message : String(error)
    try { await updateMetadataAsync(request.id, { status: loadMetadata(request.id)?.pid ? 'unknown' : 'failed', diagnostic }) } catch (error) { process.stderr.write(`Background recovery record failed: ${String(error)}\n`) }
    notify({ type: 'error', error: diagnostic })
  }).finally(() => { if (process.connected) process.disconnect(); process.exitCode = 0 })
})
