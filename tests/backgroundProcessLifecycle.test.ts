import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import ts from 'typescript'
import { captureProcessIdentity, inspectProcessIdentity } from '../src/core/processIdentity.js'
import type * as BackgroundSession from '../src/core/backgroundSession.js'

let loadMetadata: typeof BackgroundSession.loadMetadata
let startBackgroundSession: typeof BackgroundSession.startBackgroundSession
let stopSession: typeof BackgroundSession.stopSession
let updateMetadataAsync: typeof BackgroundSession.updateMetadataAsync
let compiled: string

beforeAll(async () => {
  compiled = mkdtempSync(join(tmpdir(), 'ovogo-background-modules-'))
  writeFileSync(join(compiled, 'package.json'), '{"type":"module"}')
  for (const name of ['backgroundSession', 'backgroundSupervisor', 'processTree', 'processIdentity', 'persistenceLock', 'executionBackend']) {
    const source = readFileSync(resolve(`src/core/${name}.ts`), 'utf8')
    const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
    writeFileSync(join(compiled, `${name}.js`), output)
  }
  ;({ loadMetadata, startBackgroundSession, stopSession, updateMetadataAsync } = await import(pathToFileURL(join(compiled, 'backgroundSession.js')).href))
})

afterAll(() => rmSync(compiled, { recursive: true, force: true }))

const execute = promisify(execFile)
const fixture = resolve('tests/fixtures/background-worker.mjs')
let home: string
const sessions: string[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ovogo-owned-process-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('OVOGV999_BIN', fixture)
})

afterEach(async () => {
  for (const id of sessions.splice(0)) await stopSession(id, 0)
  vi.unstubAllEnvs()
  await new Promise(resolve => setTimeout(resolve, 100))
  rmSync(home, { recursive: true, force: true })
}, 30_000)

describe('owned background process lifecycle', () => {
  it('observes executable ENOENT before reporting ready', async () => {
    await expect(startBackgroundSession({ task: 'test', cwd: home, executable: join(home, 'not-a-runtime'), readyTimeoutMs: 3000 })).rejects.toThrow(/ENOENT|spawn/i)
  }, 15_000)

  it('waits for handshake and physically stops its real process tree', async () => {
    const result = await startBackgroundSession({ task: 'test', cwd: home, readyTimeoutMs: 8000 })
    sessions.push(result.sessionId)
    const pids = JSON.parse(readFileSync(join(home, 'owned-pids.json'), 'utf8')) as { root: number; leaf: number }
    const leaf = await captureProcessIdentity(pids.leaf)
    expect(leaf).not.toBeNull()
    expect(loadMetadata(result.sessionId)?.status).toBe('running')
    expect(await stopSession(result.sessionId, 50)).toMatchObject({ accepted: true, status: 'stopped' })
    expect(await inspectProcessIdentity(leaf!)).toBe('dead')
    expect(loadMetadata(result.sessionId)?.status).toBe('cancelled')
  }, 30_000)

  it('rejects mismatched process identity without signalling a live process', async () => {
    const result = await startBackgroundSession({ task: 'test', cwd: home, readyTimeoutMs: 8000 })
    sessions.push(result.sessionId)
    const original = loadMetadata(result.sessionId)!.processIdentity!
    await updateMetadataAsync(result.sessionId, { processIdentity: { ...original, birthId: 'not-the-same-process' } })
    expect(await stopSession(result.sessionId, 0)).toMatchObject({ accepted: false, status: 'failed' })
    expect(await inspectProcessIdentity(original)).toBe('matching')
    await updateMetadataAsync(result.sessionId, { processIdentity: original })
  }, 30_000)

  it('reaps its recorded descendant when the worker exits before its child', async () => {
    const result = await startBackgroundSession({ task: 'parent-exits', cwd: home, readyTimeoutMs: 8000 })
    sessions.push(result.sessionId)
    const pids = JSON.parse(readFileSync(join(home, 'owned-pids.json'), 'utf8')) as { root: number; leaf: number }
    const leaf = await captureProcessIdentity(pids.leaf)
    expect(leaf).not.toBeNull()
    writeFileSync(join(home, 'exit-parent'), '')
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && await inspectProcessIdentity(leaf!) === 'matching') await new Promise(resolve => setTimeout(resolve, 100))
    expect(await inspectProcessIdentity(leaf!)).toBe('dead')
    expect(loadMetadata(result.sessionId)?.status).not.toBe('completed')
  }, 30_000)

  it('keeps its supervisor alive when the initiating CLI stop process exits early', async () => {
    const result = await startBackgroundSession({ task: 'test', cwd: home, readyTimeoutMs: 8000 })
    sessions.push(result.sessionId)
    const meta = loadMetadata(result.sessionId)!
    const script = `import { updateMetadataAsync } from ${JSON.stringify(pathToFileURL(join(compiled, 'backgroundSession.js')).href)}; await updateMetadataAsync(${JSON.stringify(result.sessionId)}, {status:'stopping',stopRequestedAt:new Date().toISOString(),stopGraceMs:50}); process.exit(0)`
    await execute(process.execPath, ['--input-type=module', '-e', script], { env: process.env, windowsHide: true })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && loadMetadata(result.sessionId)?.status !== 'cancelled') await new Promise(resolve => setTimeout(resolve, 100))
    expect(loadMetadata(result.sessionId)?.status).toBe('cancelled')
    expect(await inspectProcessIdentity(meta.processIdentity!)).toBe('dead')
  }, 30_000)
})
