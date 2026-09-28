import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, reports, runNode, runPnpm, isolatedEnv } from './release-utils.mjs'
import { startProvider } from './fixtures/local-provider.mjs'
import { lockPackedRuntime } from './package-lock.mjs'

mkdirSync(reports, { recursive: true })
const base = mkdtempSync(join(root, '.artifacts/release-package-'))
const installed = join(base, 'installed')
const home = join(base, 'home')
mkdirSync(installed)
mkdirSync(home)
const cases = {}
let provider, failure, identity, tarballSha256, backgroundCleanup
const started = performance.now()
const record = (name, result) => { cases[name] = { exitCode: result.code, durationMs: result.durationMs }; return result }
try {
  const stale = join(root, 'dist/stale-release-probe.js')
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(stale, 'throw new Error("stale build should never be packed")')
  const packed = record('pack', await runPnpm(['pack', '--json', '--pack-destination', base], { timeout: 180_000 }))
  let packedMetadata
  for (let index = packed.stdout.lastIndexOf('{'); index >= 0; index = packed.stdout.lastIndexOf('{', index - 1)) {
    try { packedMetadata = JSON.parse(packed.stdout.slice(index)); break } catch {}
    if (index === 0) break
  }
  assert.ok(Array.isArray(packedMetadata?.files), 'Pack did not produce a file inventory')
  assert.equal(existsSync(stale), false, 'prepack must remove stale dist files')
  const tarballs = readdirSync(base).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1)
  const tarball = join(base, tarballs[0])
  tarballSha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  const sourceManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const frozen = lockPackedRuntime(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8'), sourceManifest, tarballs[0], readFileSync(tarball))
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'ovogo-package-smoke', private: true, dependencies: { [sourceManifest.name]: frozen.reference }, scripts: { 'cli-version': 'ovolv999 --version' } }))
  writeFileSync(join(installed, 'pnpm-lock.yaml'), frozen.content)
  record('install-frozen-runtime', await runPnpm(['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'], { cwd: installed, timeout: 180_000 }))
  const packageRoot = join(installed, 'node_modules/ovogogogo')
  const files = packedMetadata.files.map(entry => entry.path)
  for (const file of files) {
    assert.ok(/^(package\.json|README\.md|LICENSE|CHANGELOG\.md|docs\/release-support\.md|dist\/build-info\.json|dist\/(bin|src)\/.+\.(js|d\.ts))$/.test(file), `Unexpected packed file: ${file}`)
    assert.ok(!/(^|\/)(tests?|__tests__|\.env|credentials|secrets)(\/|\.)|\.test\./i.test(file), `Forbidden packed file: ${file}`)
  }
  for (const file of ['LICENSE', 'README.md', 'dist/build-info.json', 'dist/bin/ovogogogo.js']) assert.ok(files.includes(file), `Missing ${file}`)
  assert.equal(existsSync(join(installed, 'node_modules/vitest')), false)
  assert.equal(existsSync(join(installed, 'node_modules/typescript')), false)
  identity = JSON.parse(readFileSync(join(packageRoot, 'dist/build-info.json'), 'utf8'))
  assert.match(identity.gitCommit, /^[a-f0-9]{40}$/)
  assert.match(identity.sourceSha256, /^[a-f0-9]{64}$/)
  assert.equal(identity.version, JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version)
  const cli = join(packageRoot, 'dist/bin/ovogogogo.js')
  const noKey = isolatedEnv(home)
  const shim = record('installed-command-shim', await runPnpm(['run', 'cli-version'], { cwd: installed, env: { ...noKey, npm_execpath: process.env.npm_execpath } }))
  assert.ok(shim.stdout.includes(identity.gitCommit))
  for (const flag of ['--help', '--version']) {
    const result = record(flag, await runNode([cli, flag], { cwd: installed, env: noKey }))
    assert.ok(result.stdout.length > 0)
    if (flag === '--version') assert.ok(result.stdout.includes(identity.gitCommit))
  }
  record('installed-esm-slash-commands', await runNode([join(root, 'scripts/fixtures/commands-installed.mjs'), join(packageRoot, 'dist/src/commands')], { cwd: installed, env: noKey }))
  const runtime = record('installed-runtime-status', await runNode([cli, '--runtime-status', join(base, 'runtime-status')], { cwd: installed, env: noKey }))
  assert.ok(runtime.stdout.length > 0)
  provider = await startProvider()
  const env = isolatedEnv(home, { OPENAI_API_KEY: 'offline-test-key', OPENAI_BASE_URL: provider.url })
  const runCli = async (name, args, input = '', allowFailure = false) => record(name, await runNode([cli, ...args], { cwd: installed, env, input, allowFailure, timeout: 45_000 }))
  const workspace = join(base, 'text')
  mkdirSync(workspace)
  writeFileSync(join(workspace, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode: 'auto' }))
  for (const [name, args, input] of [
    ['raw-pipe', ['--pipe', '--cwd', workspace, 'summarize'], 'text context'],
    ['single-task', ['--cwd', workspace, 'explain'], ''],
    ['stdin-task', ['--cwd', workspace], 'explain from stdin'],
  ]) {
    const from = provider.state.records.length
    const result = await runCli(name, args, input)
    assert.ok(result.stdout.includes('OFFLINE_SMOKE_OK'))
    if (name === 'raw-pipe') assert.ok(provider.state.records.slice(from).every(request => request.toolCount === 0))
  }
  const sessions = readdirSync(join(workspace, 'sessions')).filter(name => name.startsWith('session_'))
  assert.ok(sessions.length > 0)
  const resumed = await runCli('resume-installed-session', ['--cwd', workspace, '--resume', sessions[0], 'continue explaining'])
  assert.ok(resumed.stdout.includes('OFFLINE_SMOKE_OK'))
  provider.state.scenario = 'write'
  for (const permissionMode of ['ask', 'auto']) {
    const directory = join(base, permissionMode)
    mkdirSync(directory)
    writeFileSync(join(directory, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode }))
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }))
    writeFileSync(join(directory, 'verify.cjs'), "require('fs').writeFileSync('check-ran.txt', 'yes'); process.exit(9)")
    const result = await runCli(`${permissionMode}-failure`, ['--cwd', directory, 'write product'], '', true)
    assert.notEqual(result.code, 0)
    assert.equal(existsSync(join(directory, 'product.txt')), permissionMode === 'auto')
    if (permissionMode === 'auto') assert.equal(readFileSync(join(directory, 'check-ran.txt'), 'utf8'), 'yes')
  }
  provider.state.scenario = 'edit'
  const accepted = join(base, 'accepted')
  mkdirSync(accepted)
  writeFileSync(join(accepted, '.ovolv999.json'), JSON.stringify({ enabledModules: [], permissionMode: 'auto' }))
  writeFileSync(join(accepted, 'source.txt'), 'before')
  writeFileSync(join(accepted, 'package.json'), JSON.stringify({ scripts: { test: 'node verify.cjs' } }))
  writeFileSync(join(accepted, 'verify.cjs'), "const fs=require('fs');if(fs.readFileSync('source.txt','utf8')!=='after')process.exit(9);fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/verified','yes')")
  await runCli('read-edit-verify', ['--cwd', accepted, 'edit source'])
  assert.equal(readFileSync(join(accepted, 'source.txt'), 'utf8'), 'after')
  assert.equal(readFileSync(join(accepted, 'dist/verified'), 'utf8'), 'yes')
  const compatibility = join(base, 'compatibility')
  mkdirSync(compatibility)
  record('installed-schema-compatibility', await runNode([join(root, 'scripts/fixtures/session-compatibility.mjs'), join(packageRoot, 'dist/src/core/sessionManager.js'), compatibility], { cwd: installed, env: noKey }))
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-07-20' } },
    { jsonrpc: '2.0', id: 2, method: 'file/write', params: { path: 'forbidden.txt', content: 'forbidden' } },
  ]
  const acp = record('installed-acp-stdio', await runNode([join(root, 'scripts/fixtures/acp-installed.mjs'), join(packageRoot, 'dist/src/integrations/acp.js')], { cwd: installed, env: noKey, input: requests.map(value => JSON.stringify(value)).join('\n') + '\n' }))
  const replies = acp.stdout.trim().split('\n').map(line => JSON.parse(line))
  const initialize = replies.find(reply => reply.id === 1)
  assert.equal(initialize.result.protocolVersion, '2025-07-20')
  assert.equal(initialize.result.capabilities.tools, false)
  assert.equal(initialize.result.capabilities.worktrees, false)
  assert.ok(replies.find(reply => reply.id === 2).error)
  assert.equal(existsSync(join(installed, 'forbidden.txt')), false)
  const background = join(base, 'background')
  mkdirSync(background)
  const backgroundEnv = { ...env, OVOGV999_BIN: join(root, 'scripts/fixtures/background-worker.mjs') }
  const metadataDir = join(home, '.ovolv999/sessions')
  backgroundCleanup = async () => {
    if (!existsSync(metadataDir)) return
    for (const filename of readdirSync(metadataDir).filter(name => name.endsWith('.json'))) {
      await runNode([cli, 'stop', filename.slice(0, -5)], { cwd: installed, env: backgroundEnv, timeout: 30_000, allowFailure: true })
    }
  }
  const startResult = record('installed-background-start', await runNode([cli, '--bg', 'test', '--cwd', background], { cwd: installed, env: backgroundEnv, timeout: 30_000 }))
  const match = /Session (\S+) started in the background/.exec(startResult.stdout)
  assert.ok(match, 'Background start did not report a ready session')
  const ownedPids = JSON.parse(readFileSync(join(background, 'owned-pids.json'), 'utf8'))
  const stopResult = record('installed-background-stop', await runNode([cli, 'stop', match[1]], { cwd: installed, env: backgroundEnv, timeout: 30_000 }))
  assert.ok(stopResult.stdout.includes(`Stopped session ${match[1]}`))
  for (const pid of [ownedPids.root, ownedPids.leaf]) {
    assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH', `Owned fixture PID ${pid} survived successful stop`)
  }
  const stoppedMetadata = JSON.parse(readFileSync(join(metadataDir, `${match[1]}.json`), 'utf8'))
  assert.equal(stoppedMetadata.status, 'cancelled')
  backgroundCleanup = undefined
  process.stdout.write(`Packed CLI smoke passed: ${Object.keys(cases).length} cases; SHA256 ${tarballSha256}\n`)
} catch (error) {
  failure = error.message
  process.stderr.write(`${failure}\n`)
  process.exitCode = 1
} finally {
  if (backgroundCleanup) await backgroundCleanup()
  if (provider) await provider.close()
  writeFileSync(join(reports, 'release-package-smoke.json'), JSON.stringify({ passed: !failure, platform: process.platform, node: process.version, durationMs: Math.round(performance.now() - started), identity, tarballSha256, cases, failure }, null, 2) + '\n')
}
