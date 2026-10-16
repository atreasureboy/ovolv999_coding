import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it } from 'vitest'
import { execManaged, getExecutionHealth } from '../../src/core/executionBackend.js'
import { HookService } from '../../src/core/hookService.js'
import { getManagedProcessHealth } from '../../src/core/managedProcess.js'

const directories: string[] = []

beforeAll(() => {
  if (process.platform === 'win32') execFileSync(process.execPath, ['native/execution-host/build.mjs'], { windowsHide: true })
})

afterEach(async () => {
  await expect.poll(() => getExecutionHealth().activeProcesses).toBe(0)
  await expect.poll(() => getManagedProcessHealth()).toEqual({ activeProcesses: 0, contained: 0, observedOnly: 0, unknown: 0 })
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-managed-executable-'))
  directories.push(cwd)
  mkdirSync(join(cwd, 'tools'))
  copyFileSync(process.execPath, join(cwd, 'tools', 'fixture-node.exe'))
  expect(cwd).not.toBe(process.cwd())
  return cwd
}

it.runIf(process.platform === 'win32').each(['./tools/fixture-node.exe', '.\\tools\\fixture-node.exe', 'fixture-node'])('resolves %s from the child workspace and reviewed relative PATH', async executable => {
  const cwd = fixture()
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'))
  env.PATH = './tools'
  const output = await execManaged(executable, ['-e', 'process.stdout.write(process.cwd())'], { cwd, env, timeoutMs: 5000 })
  expect(output).toEqual({ stdout: cwd, stderr: '' })
}, 10000)

it.runIf(process.platform === 'win32')('runs a project relative policy hook in its configured workspace', async () => {
  const cwd = fixture()
  const service = new HookService({ PreToolCall: [{ command: ['./tools/fixture-node.exe', '-e', 'process.stdout.write(JSON.stringify({action:"continue",reason:process.cwd()}))'], kind: 'policy' }] }, cwd, { legacyHooks: () => ({}) })
  expect(await service.runPreToolCall('Write', { file_path: 'file.txt' })).toEqual([
    expect.objectContaining({ ok: true, status: 0, decision: { action: 'continue', reason: cwd } }),
  ])
}, 10000)
