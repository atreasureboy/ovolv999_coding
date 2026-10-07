import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { root, runNode, isolatedEnv } from '../../scripts/release-utils.mjs'
import { startProvider } from '../../scripts/fixtures/local-provider.mjs'
import { buildExecutionHost } from '../../native/execution-host/build.mjs'

let directory, provider
beforeAll(async () => {
  const base = join(root, '.artifacts', 'file-audit')
  mkdirSync(base, { recursive: true })
  directory = mkdtempSync(join(base, 'entry-lifecycle-'))
  await runNode(['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json', '--outDir', join(directory, 'compiled')])
  if (process.platform === 'win32') buildExecutionHost(join(directory, 'compiled/native/execution-host/bin'))
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
  it.each(['responses', 'anthropic'])('loads %s project configuration and sends native credentials on the real CLI', async protocol => {
    const requests = []
    const server = createServer(async (req, res) => {
      let data = ''
      for await (const chunk of req) data += chunk
      requests.push({ path: req.url, headers: req.headers, body: JSON.parse(data) })
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events = protocol === 'responses'
        ? [{ type: 'response.output_text.delta', delta: 'NATIVE_CLI_OK' }, { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'NATIVE_CLI_OK' }] }], usage: { input_tokens: 3, output_tokens: 3 } } }]
        : [{ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'NATIVE_CLI_OK' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' }]
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`)
      res.end()
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const workspace = join(directory, `${protocol}-workspace`)
      const home = join(directory, `${protocol}-home`)
      mkdirSync(workspace); mkdirSync(home)
      const modelSettings = { protocol, capabilities: { reasoning: true, contextWindow: 64000, maxOutputTokens: 4096 } }
      writeFileSync(join(workspace, '.ovolv999.json'), JSON.stringify({ model: 'fixture-native', enabledModules: [], modelSettings: { 'fixture-native': modelSettings, 'fixture-override': modelSettings } }))
      const baseURL = `http://127.0.0.1:${server.address().port}/v1`
      const result = await runNode([join(directory, 'compiled/bin/ovogogogo.js'), '--cwd', workspace, 'answer'], { env: isolatedEnv(home, protocol === 'responses' ? { OPENAI_API_KEY: 'native-fixture-key', OPENAI_BASE_URL: baseURL } : { OPENAI_API_KEY: 'unrelated-fixture-key', ANTHROPIC_API_KEY: 'native-fixture-key', ANTHROPIC_BASE_URL: baseURL }), timeout: 15_000 })
      expect(result.stdout).toContain('NATIVE_CLI_OK')
      expect(requests).toHaveLength(1)
      expect(requests[0].path).toBe(`/v1/${protocol === 'responses' ? 'responses' : 'messages'}`)
      expect(requests[0].body.model).toBe('fixture-native')
      if (protocol === 'anthropic') expect(requests[0].headers['x-api-key']).toBe('native-fixture-key')
      else expect(requests[0].headers.authorization).toBe('Bearer native-fixture-key')
      await runNode([join(directory, 'compiled/bin/ovogogogo.js'), '--cwd', workspace, '--model', 'fixture-override', 'answer again'], { env: isolatedEnv(home, protocol === 'responses' ? { OPENAI_API_KEY: 'native-fixture-key', OPENAI_BASE_URL: baseURL } : { ANTHROPIC_API_KEY: 'native-fixture-key', ANTHROPIC_BASE_URL: baseURL }), timeout: 15_000 })
      expect(requests[1].body.model).toBe('fixture-override')
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
  }, 20_000)
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
