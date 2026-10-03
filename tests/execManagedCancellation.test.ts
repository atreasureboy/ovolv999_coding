import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execManaged, getExecutionHealth } from '../src/core/executionBackend.js'
import { captureProcessIdentity, type ProcessIdentity } from '../src/core/processIdentity.js'
import { stopOwnedProcessTree } from '../src/core/processTree.js'

const directories: string[] = []
const identities: ProcessIdentity[] = []
afterEach(async () => {
  for (const identity of identities.splice(0)) await stopOwnedProcessTree({ root: identity, members: [identity], detached: process.platform !== 'win32' }, 0)
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('does not acquire process capacity for a pre-cancelled managed command', async () => {
  const controller = new AbortController()
  const reason = new Error('cancel before spawn')
  controller.abort(reason)
  const operation = execManaged(process.execPath, ['-e', 'process.exit(0)'], { signal: controller.signal })
  const observed = operation.then(value => ({ value }), error => ({ error }))
  expect(getExecutionHealth().activeProcesses).toBe(0)
  expect(await observed).toEqual({ error: reason })
})

it('stops a cancellation-resistant child and rejects with the caller cancellation reason', async () => {
  const path = mkdtempSync(join(tmpdir(), 'managed-cancel-'))
  directories.push(path)
  const pidFile = join(path, 'pid.txt')
  const controller = new AbortController()
  const reason = new Error('requested managed cancellation')
  const script = `process.on('SIGTERM', () => {}); require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const operation = execManaged(process.execPath, ['-e', script], { signal: controller.signal, timeoutMs: 15_000 })
  const rejected = expect(operation).rejects.toMatchObject({ message: reason.message, stdout: '', stderr: '' })
  const deadline = Date.now() + 5_000
  while (!existsSync(pidFile)) {
    if (Date.now() > deadline) throw new Error('Managed child did not start')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  const pid = Number(readFileSync(pidFile, 'utf8'))
  const identity = await captureProcessIdentity(pid)
  if (!identity) throw new Error('Managed child birth identity could not be captured')
  identities.push(identity)
  controller.abort(reason)
  await rejected
  expect(() => process.kill(pid, 0)).toThrow()
  expect(getExecutionHealth().activeProcesses).toBe(0)
}, 15_000)
