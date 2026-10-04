import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { root, runNode, isolatedEnv } from '../../scripts/release-utils.mjs'
import { startProvider } from '../../scripts/fixtures/local-provider.mjs'

let directory, provider
beforeAll(async () => {
  const base = join(root, '.artifacts', 'file-audit')
  mkdirSync(base, { recursive: true })
  directory = mkdtempSync(join(base, 'entry-lifecycle-'))
  await runNode(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', join(directory, 'compiled')])
  provider = await startProvider()
}, 30_000)
afterAll(async () => {
  if (provider) await provider.close()
  if (directory) {
    assert.ok(!relative(join(root, '.artifacts', 'file-audit'), directory).startsWith('..'))
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('real CLI finalization', () => {
  it('releases its initial session writer after saving the final single-task history', async () => {
    const workspace = join(directory, 'workspace')
    const home = join(directory, 'home')
    mkdirSync(workspace); mkdirSync(home)
    writeFileSync(join(workspace, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode: 'auto' }))
    const result = await runNode([join(directory, 'compiled', 'bin', 'ovogogogo.js'), '--cwd', workspace, 'explain fixture'], { env: isolatedEnv(home, { OPENAI_API_KEY: 'offline-fixture', OPENAI_BASE_URL: provider.url }), timeout: 15_000 })
    expect(result.stdout).toContain('OFFLINE_SMOKE_OK')
    const sessions = readdirSync(join(workspace, 'sessions')).filter(name => name.startsWith('session_'))
    expect(sessions).toHaveLength(1)
    expect(readdirSync(join(workspace, 'sessions', sessions[0], 'writer.lock.owners'))).toEqual([])
  }, 20_000)

  it.each(['task', 'stdin'])('returns needs_input for an unmounted Ink approval in %s execution', async (entryMode) => {
    const workspace = join(directory, `approval-${entryMode}-workspace`)
    const home = join(directory, `approval-${entryMode}-home`)
    mkdirSync(workspace); mkdirSync(home)
    writeFileSync(join(workspace, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode: 'ask' }))
    provider.state.scenario = 'write'
    const args = [join(directory, 'compiled', 'bin', 'ovogogogo.js'), '--cwd', workspace, '--ink']
    if (entryMode === 'task') args.push('request a fixture write')
    const result = await runNode(args, {
      env: isolatedEnv(home, { OPENAI_API_KEY: 'offline-fixture', OPENAI_BASE_URL: provider.url }),
      input: entryMode === 'stdin' ? 'request a fixture write\n' : '',
      timeout: 6000, allowFailure: true,
    })
    expect(result.code).toBe(2)
    expect(result.stdout).toContain('needs_input')
    expect(result.stdout).not.toContain('OFFLINE_SMOKE_OK')
    expect(existsSync(join(workspace, 'product.txt'))).toBe(false)
    const sessions = readdirSync(join(workspace, 'sessions')).filter(name => name.startsWith('session_'))
    expect(sessions).toHaveLength(1)
    expect(readdirSync(join(workspace, 'sessions', sessions[0], 'writer.lock.owners'))).toEqual([])
  }, 10_000)
})
