import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProcessScope, currentExecutionPolicy, getExecutionHealth, spawnManaged } from '../../src/core/executionBackend.js'
import { getProjectSettingsPath, loadProjectSettings, saveProjectSettings, type OvogoSettings } from '../../src/config/settings.js'
import { mergeSettingsLayers } from '../../src/config/settings/merge.js'
import { BashTool } from '../../src/tools/bash.js'
import type { ExecutionPolicy } from '../../src/core/executionPolicy.js'
import type * as PolicyApi from '../../src/core/executionPolicy.js'
import { McpStdioClient } from '../../src/core/mcpClient.js'
import { McpModule } from '../../src/modules/mcp.js'
import type { ModuleBootContext } from '../../src/core/module.js'
import type { EngineConfig } from '../../src/core/types.js'
import { loadProjectConfig } from '../../src/config/projectConfig.js'

let api: typeof PolicyApi
let cwd: string
const children: ChildProcess[] = []
const mcpFixture = fileURLToPath(new URL('../fixtures/mcpEnvironmentServer.mjs', import.meta.url))

beforeAll(async () => {
  api = await vi.importActual('../../src/core/executionPolicy.js').catch(() => ({})) as typeof api
})

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'ovo-execution-policy-'))
})

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      await once(child, 'close')
    }
  }
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(cwd, { recursive: true, force: true })
})

function policy(input?: unknown): ExecutionPolicy {
  expect(api.resolveExecutionPolicy).toBeTypeOf('function')
  return api.resolveExecutionPolicy(input, cwd)
}

async function environment(options: Parameters<typeof spawnManaged>[2] = {}): Promise<Record<string, string>> {
  const child = spawnManaged(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    ...options, cwd, stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let output = ''
  child.stdout!.on('data', data => { output += String(data) })
  const [code] = await once(child, 'close')
  expect(code).toBe(0)
  return JSON.parse(output) as Record<string, string>
}

function writeSettings(value: unknown): void {
  mkdirSync(join(cwd, '.ovogo'), { recursive: true })
  writeFileSync(getProjectSettingsPath(cwd), JSON.stringify(value))
}

function bootContext(config: Partial<EngineConfig>): ModuleBootContext {
  return { cwd, config: { cwd, model: 'offline', apiKey: 'offline', maxIterations: 1, permissionMode: 'auto', ...config } }
}

describe('execution policy', () => {
  it('defaults to truthful trusted-local boundaries and platform-essential environment only', () => {
    const resolved = policy()
    expect(resolved).toMatchObject({ mode: 'trusted-local', readableRoots: [], writableRoots: [], deniedPaths: [], network: 'unrestricted', allowedHosts: [], limits: { processes: 64 } })
    const env = api.buildChildEnvironment(resolved, { PATH: 'essential-path', OVOGO_TEST_API_KEY: 'fictional-secret', OVOGO_VISIBLE: 'ambient-custom' })
    expect(env.PATH).toBe('essential-path')
    expect(env.OVOGO_TEST_API_KEY).toBeUndefined()
    expect(env.OVOGO_VISIBLE).toBeUndefined()
  })

  it('keeps explicitly allowed custom variables without mutating its source', () => {
    const source = { PATH: 'essential-path', OVOGO_VISIBLE: 'explicit', OVOGO_TEST_API_KEY: 'fictional-secret' }
    const resolved = policy({ envAllowlist: ['OVOGO_VISIBLE'] })
    expect(api.buildChildEnvironment(resolved, source)).toMatchObject({ OVOGO_VISIBLE: 'explicit' })
    expect(api.buildChildEnvironment(resolved, source).OVOGO_TEST_API_KEY).toBeUndefined()
    expect(source.OVOGO_TEST_API_KEY).toBe('fictional-secret')
  })

  it('normalizes Windows PATH casing and emits only one case-insensitive variable', () => {
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'platform' ? 'win32' : Reflect.get(target, key) } }))
    const resolved = api.resolveExecutionPolicy({ envAllowlist: ['custom_value'] }, 'C:\\workspace')
    const env = api.buildChildEnvironment(resolved, { Path: 'mixed-case-path', PATH: 'canonical-path', CUSTOM_VALUE: 'allowed', secret: 'hidden' })
    expect(env.PATH).toBe('canonical-path')
    expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toHaveLength(1)
    expect(env.CUSTOM_VALUE).toBe('allowed')
    expect(env.secret).toBeUndefined()
  })

  it('gives explicit Windows environment overrides precedence over differently cased ambient names', () => {
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'platform' ? 'win32' : Reflect.get(target, key) } }))
    expect(api.mergeChildEnvironment({ PATH: 'ambient', SECRET: 'parent' }, { Path: 'explicit', secret: 'explicit-owned' })).toEqual({ PATH: 'explicit', SECRET: 'explicit-owned' })
  })

  it.each([
    null,
    { mode: 'unknown' },
    { limits: { processes: 0 } },
    { limits: { memoryBytes: -1 } },
    { envAllowlist: ['NAME=value'] },
    { network: 'allowlist', allowedHosts: [] },
    { network: 'deny', allowedHosts: ['example.com'] },
    { allowAllSecrets: true },
  ])('rejects malformed policy rather than defaulting trusted-local: %j', input => {
    expect(() => policy(input)).toThrow()
  })

  it('rejects relative, traversal and writable-outside-readable roots', () => {
    expect(() => policy({ readableRoots: ['../sensitive'] })).toThrow(/absolute|root|path/i)
    expect(() => policy({ readableRoots: [`${cwd}${sep}..${sep}sensitive`] })).toThrow(/traversal|root|path/i)
    expect(() => policy({ readableRoots: [join(cwd, 'readable')], writableRoots: [join(cwd, 'other')] })).toThrow(/scope|readable/i)
  })

  it('retains valid unsupported restrictions and refuses them before spawn', () => {
    const inputs = [
      { mode: 'isolated-worker' }, { readableRoots: [cwd] }, { deniedPaths: [join(cwd, 'private')] },
      { network: 'deny' }, { network: 'allowlist', allowedHosts: ['example.com'] },
      { limits: { memoryBytes: 1024 } }, { limits: { cpuMs: 10 } },
    ]
    const marker = join(cwd, 'must-not-launch.txt')
    for (const input of inputs) {
      const resolved = policy(input)
      expect(() => children.push(spawnManaged(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'launched')`], { cwd, policy: resolved }))).toThrow(/unavailable|unsupported|refused/i)
    }
    expect(existsSync(marker)).toBe(false)
    expect(getExecutionHealth().activeProcesses).toBe(0)
  })

  it('does not leak an ambient credential into a real default managed child', async () => {
    const env = await environment({ env: { ...process.env, OVOGO_TEST_API_KEY: 'fictional-policy-credential', OVOGO_VISIBLE: 'ambient-value' } })
    expect(env.OVOGO_TEST_API_KEY).toBeUndefined()
    expect(env.OVOGO_VISIBLE).toBeUndefined()
  })

  it('preserves the legacy explicit environment and process-capacity profile', async () => {
    const env = await environment({ env: { ...process.env, OVOGO_TEST_API_KEY: 'fictional-policy-credential', OVOGO_VISIBLE: 'explicit-value' }, profile: { mode: 'trusted-local', envAllowlist: ['OVOGO_VISIBLE'], maxProcesses: 2 } })
    expect(env.OVOGO_VISIBLE).toBe('explicit-value')
    expect(env.OVOGO_TEST_API_KEY).toBeUndefined()
  })

  it('inherits policy environment in a real Bash subprocess', async () => {
    vi.stubEnv('OVOGO_TEST_API_KEY', 'fictional-policy-credential')
    vi.stubEnv('OVOGO_VISIBLE', 'explicit-value')
    const command = `"${process.execPath}" -e "process.stdout.write(JSON.stringify({secret:process.env.OVOGO_TEST_API_KEY,visible:process.env.OVOGO_VISIBLE}))"`
    const result = await createProcessScope(undefined, policy({ envAllowlist: ['OVOGO_VISIBLE'] })).run(() => new BashTool().execute({ command }, { cwd, permissionMode: 'auto' }))
    expect(result.isError).toBe(false)
    expect(result.content).toContain('explicit-value')
    expect(result.content).not.toContain('fictional-policy-credential')
  })

  it('excludes ambient credentials while allowing literal server.env values in a real MCP child', async () => {
    vi.stubEnv('OVOGO_TEST_API_KEY', 'fictional-policy-credential')
    const client = new McpStdioClient({ name: 'environment', type: 'stdio', command: [process.execPath, mcpFixture], cwd, env: { OVOGO_EXPLICIT: 'literal-server-value' } })
    try {
      await client.connect()
      const result = await client.callTool('environment', {})
      const env = JSON.parse(result.content) as Record<string, string>
      expect(env.OVOGO_TEST_API_KEY).toBeUndefined()
      expect(env.OVOGO_EXPLICIT).toBe('literal-server-value')
    } finally { await client.close() }
  })

  it.skipIf(process.platform !== 'win32')('honors a mixed-case explicit MCP Path override in a real Windows child', async () => {
    const ambientPath = process.env.PATH ?? ''
    const explicitPath = ambientPath + ';OVOGO_EXPLICIT_PATH'
    const source = { ...process.env, PATH: ambientPath }
    vi.stubGlobal('process', new Proxy(process, { get(target, key): unknown { return key === 'env' ? source : Reflect.get(target, key) } }))
    const client = new McpStdioClient({ name: 'environment', type: 'stdio', command: [process.execPath, mcpFixture], cwd, env: { Path: explicitPath } })
    try {
      await client.connect()
      const env = JSON.parse((await client.callTool('environment', {})).content) as Record<string, string>
      expect(env.PATH).toBe(explicitPath)
      expect(Object.keys(env).filter(key => key.toLowerCase() === 'path')).toHaveLength(1)
    } finally { await client.close() }
  })

  it('propagates engine policy to a real MCP module child and retains explicit server environment', async () => {
    vi.stubEnv('OVOGO_TEST_API_KEY', 'fictional-policy-credential')
    vi.stubEnv('OVOGO_VISIBLE', 'policy-allowed-ambient')
    const module = new McpModule()
    try {
      const boot = await module.boot(bootContext({ executionPolicy: policy({ envAllowlist: ['OVOGO_VISIBLE'] }), mcp: { servers: [{ name: 'environment', type: 'stdio', command: [process.execPath, mcpFixture], env: { OVOGO_EXPLICIT: 'literal-server-value' } }] } }))
      const result = await boot.tools![0].execute({}, { cwd, permissionMode: 'auto' })
      const env = JSON.parse(result.content) as Record<string, string>
      expect(env.OVOGO_TEST_API_KEY).toBeUndefined()
      expect(env.OVOGO_VISIBLE).toBe('policy-allowed-ambient')
      expect(env.OVOGO_EXPLICIT).toBe('literal-server-value')
    } finally { await module.dispose() }
  })

  it('does not overwrite a server isolation request with the engine trusted profile', async () => {
    const module = new McpModule()
    const marker = join(cwd, 'must-not-launch-mcp.txt')
    try {
      await expect(module.boot(bootContext({ executionProfile: { mode: 'trusted-local' }, mcp: { servers: [{ name: 'environment', type: 'stdio', command: [process.execPath, mcpFixture], env: { OVOGO_START_MARKER: marker }, executionProfile: { mode: 'isolated-worker' } }] } }))).rejects.toThrow(/isolation.*unavailable|refused/i)
      expect(existsSync(marker)).toBe(false)
    } finally { await module.dispose() }
  })

  it('does not let a child scope or explicit trusted option bypass unsupported ancestor policy', () => {
    const outer = createProcessScope(undefined, policy({ mode: 'isolated-worker' }))
    return outer.run(() => {
      expect(() => children.push(spawnManaged(process.execPath, ['-e', 'process.exit(0)'], { policy: policy() }))).toThrow(/isolation.*unavailable|refused/i)
      return Promise.resolve()
    })
  })

  it('reports and enforces the ancestor process capacity when a nested scope requests more', () => {
    return createProcessScope(undefined, policy({ limits: { processes: 1 } })).run(() =>
      createProcessScope(undefined, policy({ limits: { processes: 10 } })).run(async () => {
        expect(currentExecutionPolicy(cwd).limits.processes).toBe(1)
        const child = spawnManaged(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
        children.push(child)
        await once(child, 'spawn')
        expect(() => children.push(spawnManaged(process.execPath, ['-e', 'process.exit(0)']))).toThrow(/capacity/i)
        child.kill()
        await once(child, 'close')
      }),
    )
  })

  it.each([{ mode: 'isolated-worker' }, { network: 'deny' }, { limits: { memoryBytes: 1024 } }])('refuses policy-environment helpers inside an unsupported ancestor scope: %j', input => {
    return createProcessScope(undefined, policy(input)).run(() =>
      createProcessScope(undefined, policy()).run(() => {
        expect(() => currentExecutionPolicy(cwd)).toThrow(/unavailable|unsupported|refused/i)
        return Promise.resolve()
      }),
    )
  })

  it('persists execution policies, legacy profiles and MCP capacities across settings restart', () => {
    const saved = {
      executionPolicy: { envAllowlist: ['OVOGO_VISIBLE'], limits: { processes: 3, memoryBytes: 4096 } },
      executionProfile: { mode: 'isolated-worker', maxProcesses: 2 },
      mcp: { servers: [{ name: 'server', type: 'stdio', command: [process.execPath], executionProfile: { mode: 'isolated-worker', maxProcesses: 2 }, limits: { maxFrameBytes: 1024, maxPending: 2 } }] },
    } as OvogoSettings
    saveProjectSettings(cwd, saved)
    const loaded = loadProjectSettings(cwd)
    expect(loaded.executionPolicy).toEqual(saved.executionPolicy)
    expect(loaded.executionProfile).toEqual(saved.executionProfile)
    expect(loaded.mcp?.servers[0].executionProfile).toEqual(saved.mcp!.servers[0].executionProfile)
    expect(loaded.mcp?.servers[0].limits).toEqual(saved.mcp!.servers[0].limits)
  })

  it('inherits omitted policy fields and limits through settings layers', () => {
    const merged = mergeSettingsLayers({ executionPolicy: { mode: 'isolated-worker', envAllowlist: ['GLOBAL'], limits: { processes: 2, memoryBytes: 100 } } }, { executionPolicy: { envAllowlist: ['PROJECT'], limits: { cpuMs: 20 } } })
    expect(merged.executionPolicy).toEqual({ mode: 'isolated-worker', envAllowlist: ['PROJECT'], limits: { processes: 2, memoryBytes: 100, cpuMs: 20 } })
  })

  it.each([
    { executionPolicy: { mode: 'invalid' } },
    { executionProfile: { mode: 'trusted-local', maxProcesses: 0 } },
    { mcp: { servers: [{ name: 'invalid', command: [process.execPath], executionProfile: { mode: 'invalid' } }] } },
    { mcp: { servers: [{ name: 'invalid', command: [process.execPath], limits: { maxFrameBytes: 0 } }] } },
  ])('fails closed with a source path for invalid saved execution requirements: %j', value => {
    writeSettings(value)
    expect(() => loadProjectSettings(cwd)).toThrow(getProjectSettingsPath(cwd))
  })

  it('fails closed when malformed JSON declares an execution policy', () => {
    mkdirSync(join(cwd, '.ovogo'), { recursive: true })
    writeFileSync(getProjectSettingsPath(cwd), '{"executionPolicy":')
    expect(() => loadProjectSettings(cwd)).toThrow(getProjectSettingsPath(cwd))
  })

  it.each(['{"\\u0065xecutionPolicy":', '{broken', 'null', '[]', '"settings"'])('fails closed for every malformed or non-object settings file: %s', content => {
    mkdirSync(join(cwd, '.ovogo'), { recursive: true })
    writeFileSync(getProjectSettingsPath(cwd), content)
    expect(() => loadProjectSettings(cwd)).toThrow(getProjectSettingsPath(cwd))
  })

  it('fails closed with a source path when an existing settings file cannot be read', () => {
    mkdirSync(getProjectSettingsPath(cwd), { recursive: true })
    expect(() => loadProjectSettings(cwd)).toThrow(getProjectSettingsPath(cwd))
  })

  it.each(['{"\\u0065xecutionPolicy":', '{broken', 'null', '[]'])('fails closed for malformed or non-object project configuration: %s', content => {
    const path = join(cwd, '.ovolv999.json')
    writeFileSync(path, content)
    expect(() => loadProjectConfig(cwd)).toThrow(path)
  })

  it('preserves project execution requirements and diagnoses invalid project policy', () => {
    const path = join(cwd, '.ovolv999.json')
    writeFileSync(path, JSON.stringify({ executionPolicy: { limits: { memoryBytes: 1024 } }, executionProfile: { mode: 'isolated-worker', maxProcesses: 2 } }))
    expect(loadProjectConfig(cwd)).toMatchObject({ executionPolicy: { limits: { memoryBytes: 1024 } }, executionProfile: { mode: 'isolated-worker', maxProcesses: 2 } })
    writeFileSync(path, JSON.stringify({ executionPolicy: { mode: 'invalid' } }))
    expect(() => loadProjectConfig(cwd)).toThrow(path)
  })
})
