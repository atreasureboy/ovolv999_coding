import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { HookService } from '../../src/core/hookService.js'

const directories: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function cwd() {
  const directory = mkdtempSync(join(tmpdir(), 'ovo-hook-service-'))
  directories.push(directory)
  return directory
}

function command(action: string, target?: string) {
  return [process.execPath, resolve('scripts/fixtures/hook-runtime.mjs'), action, ...(target ? [target] : [])]
}

it('executes declared policies asynchronously and carries native denial to the engine contract', async () => {
  const service = new HookService({ PreToolCall: [{ command: command('deny'), kind: 'policy', matcher: 'Write' }] }, cwd(), { legacyHooks: () => ({}) })
  const pending = service.runPreToolCall('Write', { file_path: 'file.txt' })
  expect(pending).toBeInstanceOf(Promise)
  const results = await pending
  expect(results).toEqual([expect.objectContaining({ ok: false, status: 2, decision: { action: 'deny', reason: 'protected file' } })])
})

it('honors the existing /hooks configuration and records each post notification once', async () => {
  const directory = cwd()
  const record = join(directory, 'post-events.txt')
  const service = new HookService({}, directory, { legacyHooks: () => ({
    PreToolUse: [{ matcher: 'Write', command: command('deny') }],
    PostToolUse: [{ matcher: 'Write', command: command('record', record) }],
  }) })
  expect((await service.runPreToolCall('Write', {}))[0].decision?.action).toBe('deny')
  await service.runPostToolCall('Write', 'blocked', true)
  expect(readFileSync(record, 'utf8')).toBe('PostToolUse\n')
})

it('excludes ambient API keys from the real child environment', async () => {
  vi.stubEnv('OVOGO_TEST_API_KEY', 'fictional-hook-test-credential')
  const service = new HookService({ PreToolCall: [{ command: command('environment'), kind: 'policy' }] }, cwd(), { legacyHooks: () => ({}) })
  const result = (await service.runPreToolCall('Write', {}))[0]
  expect(result.decision).toEqual({ action: 'continue', reason: 'credential absent' })
})

it('fails closed for a declared policy while preserving notification failure behavior', async () => {
  const warn = vi.fn()
  const service = new HookService({ PreToolCall: [
    { command: command('fail'), kind: 'notification' },
    { command: command('fail'), kind: 'policy' },
  ] }, cwd(), { legacyHooks: () => ({}), sink: { warn } })
  const results = await service.runPreToolCall('Write', {})
  expect(results[0].decision).toBeUndefined()
  expect(results[1].decision?.action).toBe('deny')
  expect(warn).toHaveBeenCalledTimes(2)
})

it('maps policy JSON to an updated input and leaves legacy notification output inert', async () => {
  const service = new HookService({ PreToolCall: [{ command: command('rewrite', 'new.txt'), kind: 'policy' }] }, cwd(), { legacyHooks: () => ({}) })
  expect((await service.runPreToolCall('Write', {}))[0].decision).toEqual({
    action: 'continue', updatedInput: { file_path: 'new.txt', content: 'changed' },
  })
})

it('scrubs ambient secret values from policy errors and warning output', async () => {
  const secret = 'fictional-hook-test-credential'
  vi.stubEnv('OVOGO_TEST_API_KEY', secret)
  const warn = vi.fn()
  const service = new HookService({ PreToolCall: [{ command: command('leak', secret), kind: 'policy' }] }, cwd(), { legacyHooks: () => ({}), sink: { warn } })
  const results = await service.runPreToolCall('Write', {})
  expect(results[0].decision?.reason).toBe('[REDACTED]')
  expect(JSON.stringify(results)).not.toContain(secret)
  expect(JSON.stringify(warn.mock.calls)).not.toContain(secret)
})
