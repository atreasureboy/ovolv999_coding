import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { getMetadataPath, startBackgroundSession, stopSession } from '../../src/core/backgroundSession.js'
import { resolveExecutionPolicy } from '../../src/core/executionPolicy.js'

const fixtures: Array<{ cwd: string; sessionId?: string }> = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    if (fixture.sessionId) {
      const result = await stopSession(fixture.sessionId, 0)
      if (result.status !== 'stopped') throw new Error('Background environment fixture still owns resources')
    }
    rmSync(fixture.cwd, { recursive: true, force: true })
  }
  vi.unstubAllEnvs()
})

it('delivers explicitly supplied model credentials to a supervised worker without inheriting unrelated secrets or persisting credentials', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-background-environment-'))
  const fixture: { cwd: string; sessionId?: string } = { cwd }
  fixtures.push(fixture)
  vi.stubEnv('HOME', cwd)
  vi.stubEnv('USERPROFILE', cwd)
  vi.stubEnv('OVOGV999_BIN', resolve('tests/fixtures/background-environment.mjs'))
  vi.stubEnv('OVO_TEST_SECRET_TOKEN', 'offline-unrelated-secret')
  const session = await startBackgroundSession({ task: 'inspect environment', cwd, readyTimeoutMs: 5000,
    executionPolicy: resolveExecutionPolicy(undefined, cwd),
    env: { OPENAI_API_KEY: 'offline-model-credential', OVO_TEST_ALLOWED: 'explicit-worker-extra' },
  })
  fixture.sessionId = session.sessionId
  expect(JSON.parse(readFileSync(join(cwd, 'worker-environment.json'), 'utf8'))).toEqual({
    ambientSecret: false, modelCredential: true, extra: 'explicit-worker-extra', supervised: true, sessionId: session.sessionId,
  })
  const metadata = readFileSync(getMetadataPath(session.sessionId), 'utf8')
  expect(metadata).not.toContain('offline-model-credential')
  expect(metadata).not.toContain('offline-unrelated-secret')
}, 15000)
