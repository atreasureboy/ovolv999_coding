import { expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runLoop } from '../../src/core/loopEngine.js'
import { withWorkspaceAccess } from '../../src/core/runContext.js'
import * as verification from '../../src/core/verification.js'
import type { ExecutionEngine } from '../../src/core/engine.js'
import type { Renderer } from '../../src/ui/renderer.js'

it('persists the loop acceptance receipt before yielding the workspace to a queued writer', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'loop-acceptance-atomicity-'))
  const loopDir = join(cwd, '.loop')
  mkdirSync(loopDir)
  writeFileSync(join(loopDir, 'GOAL.md'), 'Accept current artifact')
  writeFileSync(join(loopDir, 'ACCEPTANCE.md'), '- [ ] A1: accepted `node check.cjs`')
  writeFileSync(join(cwd, 'artifact.txt'), 'verified version')
  let writer: Promise<void> | undefined
  let receiptAtNextWrite: string | undefined
  const engine = { runTurn: () => Promise.resolve({ result: { reason: 'stop_sequence', status: 'completed', output: 'done' } }), abort() {}, getConfig: () => ({}) } as unknown as ExecutionEngine
  const renderer = new Proxy({}, { get: () => () => undefined }) as Renderer
  vi.spyOn(verification, 'executeVerification').mockImplementation(async options => {
    writer = withWorkspaceAccess(cwd, 'queued-writer', true, new AbortController().signal, () => {
      receiptAtNextWrite = existsSync(join(loopDir, 'DONE.flag')) ? readFileSync(join(loopDir, 'DONE.flag'), 'utf8') : undefined
      writeFileSync(join(cwd, 'artifact.txt'), 'unverified version')
      return Promise.resolve()
    })
    await new Promise(resolve => setTimeout(resolve, 25))
    return { status: 'passed', workspace: cwd, artifactVersion: options.artifactVersion, definitionHash: options.plan?.definitionHash, runId: options.runId, commands: [], output: 'passed' }
  })
  try {
    const result = await runLoop(engine, renderer, { cwd, loopDir, maxIters: 1 })
    await writer
    expect(result.status).toBe('completed')
    expect(receiptAtNextWrite).toBeDefined()
    expect(JSON.parse(receiptAtNextWrite!).artifactVersion).toBe(result.verification.artifactVersion)
  } finally {
    vi.restoreAllMocks()
    await writer
    rmSync(cwd, { recursive: true, force: true })
  }
})
