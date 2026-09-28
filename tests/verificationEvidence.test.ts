import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { captureArtifactVersion, createVerificationPlan, executeVerification } from '../src/core/verification.js'

describe('verification evidence', () => {
  it('excludes the explicit runtime session while retaining adjacent native artifacts', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-session-evidence-'))
    const sessionDir = join(cwd, 'sessions', 'session_current')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'events.ndjson'), 'first')
    const before = await captureArtifactVersion(cwd, [sessionDir])
    writeFileSync(join(sessionDir, 'events.ndjson'), 'later')
    expect(await captureArtifactVersion(cwd, [sessionDir])).toBe(before)
    writeFileSync(join(cwd, 'product.txt'), 'real artifact')
    expect(await captureArtifactVersion(cwd, [sessionDir])).not.toBe(before)
  })
  it('captures native writes when the entire workspace is ignored by its parent repository', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'ovogo-ignored-workspace-'))
    execFileSync('git', ['init'], { cwd: repository, stdio: 'ignore' })
    writeFileSync(join(repository, '.gitignore'), 'ignored/\n')
    const cwd = join(repository, 'ignored', 'project')
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(7)"' } }))
    const before = await captureArtifactVersion(cwd)
    writeFileSync(join(cwd, 'product.txt'), 'created by native Write')
    expect(await captureArtifactVersion(cwd)).not.toBe(before)
    expect((await executeVerification({ cwd })).status).toBe('failed')
  })

  it('keeps verification valid while its explicit runtime session records output', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-session-verification-'))
    const sessionDir = join(cwd, 'sessions', 'session_current')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(join(sessionDir, 'events.ndjson'), 'first')
    writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('sessions/session_current/events.ndjson','later')")
    const plan = createVerificationPlan(cwd, ['node check.cjs'], [sessionDir])
    const evidence = await executeVerification({ cwd, plan })
    expect(evidence.status).toBe('passed')
    expect(evidence.artifactVersion).toBe(await captureArtifactVersion(cwd, plan.excludedPaths))
  })

  it('captures an ignored native file even when other tracked files populate the inventory', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-ignored-file-'))
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    writeFileSync(join(cwd, '.gitignore'), 'product.txt\n')
    execFileSync('git', ['add', '.gitignore'], { cwd, stdio: 'ignore' })
    const before = await captureArtifactVersion(cwd)
    writeFileSync(join(cwd, 'product.txt'), 'created by native Write')
    expect(await captureArtifactVersion(cwd)).not.toBe(before)
  })
  it('invalidates evidence when a tracked generated-directory artifact changes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    execFileSync('git', ['init'], { cwd, stdio: 'ignore' })
    mkdirSync(join(cwd, 'dist'))
    writeFileSync(join(cwd, 'dist', 'artifact.js'), 'before')
    execFileSync('git', ['add', 'dist/artifact.js'], { cwd, stdio: 'ignore' })
    const before = await captureArtifactVersion(cwd)
    writeFileSync(join(cwd, 'dist', 'artifact.js'), 'after')
    expect(await captureArtifactVersion(cwd)).not.toBe(before)
  })
  it('binds successful checks to the workspace and current artifact bytes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    writeFileSync(join(cwd, 'source.txt'), 'original')
    const version = await captureArtifactVersion(cwd)
    const evidence = await executeVerification({ cwd, runId: 'test-run', plan: createVerificationPlan(cwd, ['node -e "process.exit(0)"']) })
    expect(evidence.status).toBe('passed')
    expect(evidence.runId).toBe('test-run')
    expect(evidence.artifactVersion).toBe(version)
    writeFileSync(join(cwd, 'source.txt'), 'changed')
    expect(await captureArtifactVersion(cwd)).not.toBe(version)
  })

  it('invalidates checks that modify the source under verification', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    writeFileSync(join(cwd, 'source.txt'), 'original')
    writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('source.txt','different')")
    const evidence = await executeVerification({ cwd, plan: createVerificationPlan(cwd, ['node check.cjs']) })
    expect(evidence.commands[0].passed).toBe(true)
    expect(evidence.status).toBe('failed')
  })

  it('refuses changed acceptance scripts before executing them', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node check.cjs' } }))
    writeFileSync(join(cwd, 'check.cjs'), "require('fs').writeFileSync('ran.txt','yes')")
    const plan = createVerificationPlan(cwd)
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }))
    const evidence = await executeVerification({ cwd, plan })
    expect(evidence.status).toBe('failed')
    expect(evidence.commands).toEqual([])
    expect(existsSync(join(cwd, 'ran.txt'))).toBe(false)
  })

  it('cancels a real verification process before a delayed write', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    writeFileSync(join(cwd, 'check.cjs'), "setTimeout(() => require('fs').writeFileSync('late.txt','bad'), 1000)")
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 200)
    try {
      const evidence = await executeVerification({ cwd, signal: controller.signal, plan: createVerificationPlan(cwd, ['node check.cjs']) })
      expect(evidence.status).not.toBe('passed')
      expect(evidence.commands[0]?.cancelled).toBe(true)
      await new Promise(resolve => setTimeout(resolve, 1100))
      expect(existsSync(join(cwd, 'late.txt'))).toBe(false)
    } finally {
      clearTimeout(timer)
    }
  }, 7000)

  it('reports an empty acceptance set as not applicable', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'ovogo-evidence-'))
    expect((await executeVerification({ cwd })).status).toBe('not_applicable')
  })
})
