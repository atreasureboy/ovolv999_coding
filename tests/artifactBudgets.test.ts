import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { captureArtifactVersion, createVerificationPlan, executeVerification } from '../src/core/verification.js'

const roots: string[] = []
function directory(): string { const root = mkdtempSync(join(tmpdir(), 'ovo-artifact-')); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('fails a byte budget instead of omitting a large artifact', async () => {
  const cwd = directory()
  writeFileSync(join(cwd, 'large.bin'), Buffer.alloc(1024 * 1024, 1))
  await expect(captureArtifactVersion(cwd, [], { maxBytes: 100 })).rejects.toThrow(/byte budget/i)
})

it('checks cancellation before scanning and reports measured streaming bytes', async () => {
  const cwd = directory()
  writeFileSync(join(cwd, 'large.bin'), Buffer.alloc(1024 * 1024, 1))
  const controller = new AbortController(); controller.abort()
  await expect(captureArtifactVersion(cwd, [], { signal: controller.signal })).rejects.toBeDefined()
  const measurements: Array<{ bytes: number; files: number }> = []
  const first = await captureArtifactVersion(cwd, [], { onMetrics: value => measurements.push(value) })
  expect(measurements[0]).toMatchObject({ bytes: 1024 * 1024, files: 1 })
  writeFileSync(join(cwd, 'large.bin'), Buffer.alloc(1024 * 1024, 2))
  expect(await captureArtifactVersion(cwd)).not.toBe(first)
})

it('records scope and kind without treating compilation as behavioral acceptance', async () => {
  const cwd = directory()
  const plan = createVerificationPlan(cwd, [`"${process.execPath}" -e "process.exit(0)"`], [], [{ kind: 'compile', scope: 'workspace' }])
  const evidence = await executeVerification({ cwd, plan })
  expect(evidence.status).toBe('passed')
  expect(evidence.sufficientForCompletion).toBe(false)
  expect(evidence.commands[0]).toMatchObject({ kind: 'compile', scope: 'workspace' })
})
