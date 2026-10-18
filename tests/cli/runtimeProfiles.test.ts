import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createRuntimeConfigurationResolver, resolveProfilePermissionMode } from '../../src/cli/runtimeConfiguration.js'
import { createProfile, getActiveProfile, setActiveProfile } from '../../src/core/profiles.js'
import { ExecutionEngine } from '../../src/core/engine.js'
import { resourcesCommands } from '../../src/commands/resourcesCommands.js'
import type { SlashCommandContext } from '../../src/commands/index.js'
import type { Renderer } from '../../src/ui/renderer.js'
import { AgentSessionClient } from '../../src/core/agentSessionClient.js'

const directories: string[] = []
const disposals: Array<() => Promise<void>> = []
const observer = new Proxy({}, { get: () => () => {} }) as Renderer

afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose()
  for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true })
})

function workspace() {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-profile-config-'))
  directories.push(cwd)
  return cwd
}

it('resolves explicit model, profile settings, project settings and environment in order without mutating the environment', () => {
  const cwd = workspace()
  const env = { OPENAI_API_KEY: 'base-key', OVOGO_TEMPERATURE: '0.1', OVOGO_MAX_OUTPUT_TOKENS: '4096' }
  createProfile(cwd, 'work', { provider: { name: 'openai', model: 'profile-model', baseUrl: 'http://127.0.0.1:9001/v1', apiKeyEnv: 'WORK_KEY' }, env: { WORK_KEY: 'work-key' }, modelPrefs: { temperature: 0.3, maxTokens: 1024 }, permissionLevel: 'strict' })
  const options = { model: 'env-model', projectConfig: { model: 'project-model', temperature: 0.2, permissionMode: 'deny' as const }, env }
  expect(createRuntimeConfigurationResolver(cwd, options)()).toMatchObject({ model: 'profile-model', apiKey: 'work-key', baseURL: 'http://127.0.0.1:9001/v1', temperature: 0.3, maxOutputTokens: 1024, permissionMode: 'deny', requireToolApproval: true })
  expect(createRuntimeConfigurationResolver(cwd, { ...options, model: 'explicit-model', modelExplicit: true })().model).toBe('explicit-model')
  expect(env).toEqual({ OPENAI_API_KEY: 'base-key', OVOGO_TEMPERATURE: '0.1', OVOGO_MAX_OUTPUT_TOKENS: '4096' })
})

it('selects the named provider credentials without leaking MiniMax automatic environment detection', () => {
  const cwd = workspace()
  createProfile(cwd, 'openai', { provider: { name: 'openai' } })
  const resolve = createRuntimeConfigurationResolver(cwd, { model: 'fixture', env: { OPENAI_API_KEY: 'openai-key', ANTHROPIC_AUTH_TOKEN: 'minimax-key', ANTHROPIC_BASE_URL: 'https://api.minimax.io/anthropic' } })
  expect(resolve()).toMatchObject({ apiKey: 'openai-key', baseURL: undefined, modelProtocol: 'chat-completions' })
})

it('changes native provider protocol and restores all inherited settings when leaving a profile', () => {
  const cwd = workspace()
  createProfile(cwd, 'base')
  createProfile(cwd, 'native', { provider: { name: 'anthropic', model: 'native-model', apiKeyEnv: 'NATIVE_KEY', baseUrl: 'http://127.0.0.1:9002/v1' }, env: { NATIVE_KEY: 'native-key' }, modelPrefs: { temperature: 0.5, maxTokens: 1000 }, permissionLevel: 'strict' })
  const resolve = createRuntimeConfigurationResolver(cwd, { model: 'fixture', env: { OPENAI_API_KEY: 'base-key', OVOGO_MODEL_PROTOCOL: 'responses' } })
  const baseline = resolve()
  setActiveProfile(cwd, 'native')
  expect(resolve()).toMatchObject({ model: 'native-model', modelProtocol: 'anthropic', apiKey: 'native-key', baseURL: 'http://127.0.0.1:9002/v1', requireToolApproval: true })
  setActiveProfile(cwd, 'base')
  expect(resolve()).toEqual(baseline)
})

it('rolls back a rejected live profile so restart retains the last usable provider', async () => {
  const cwd = workspace()
  createProfile(cwd, 'base')
  createProfile(cwd, 'invalid', { provider: { name: 'openai', baseUrl: 'file:///invalid' }, permissionLevel: 'strict' })
  const resolve = createRuntimeConfigurationResolver(cwd, { model: 'fixture', env: { OPENAI_API_KEY: 'base-key' } })
  const engine = new ExecutionEngine({ cwd, maxIterations: 1, enabledModules: [], ...resolve(), resolveRuntimeConfiguration: resolve }, observer)
  disposals.push(() => engine.dispose())
  const ctx: SlashCommandContext = { cwd, engine, renderer: observer, history: [], setHistory: () => {}, runPrompt: () => {} }
  await expect(resourcesCommands.find(command => command.name === 'profile')!.handler('switch invalid', ctx)).rejects.toThrow(/HTTP/)
  expect(getActiveProfile(cwd)?.name).toBe('base')
  expect(engine.getConfig().baseURL).toBeUndefined()
  expect(engine.getConfig().requireToolApproval).toBe(false)
})

it('keeps live profile resolution after session replacement and restores normal approval state', async () => {
  const cwd = workspace()
  writeFileSync(join(cwd, '.ovolv999.json'), JSON.stringify({ permissionMode: 'ask' }))
  createProfile(cwd, 'base')
  createProfile(cwd, 'strict', { permissionLevel: 'strict', modelPrefs: { temperature: 0.3 } })
  const resolve = createRuntimeConfigurationResolver(cwd, { model: 'fixture', projectConfig: { permissionMode: 'ask' }, env: { OPENAI_API_KEY: 'fixture' } })
  const engine = new ExecutionEngine({ cwd, maxIterations: 1, enabledModules: [], ...resolve(), resolveRuntimeConfiguration: resolve }, observer)
  const client = new AgentSessionClient({ cwd, engine, observer })
  disposals.push(() => client.dispose())
  await client.initialize()
  mkdirSync(join(cwd, 'next-session'))
  await client.switchSession(join(cwd, 'next-session'))
  const ctx: SlashCommandContext = { cwd, engine: client.engine, renderer: observer, history: [], setHistory: () => {}, runPrompt: () => {} }
  const profile = resourcesCommands.find(command => command.name === 'profile')!
  await profile.handler('switch strict', ctx)
  expect(client.engine.getConfig()).toMatchObject({ requireToolApproval: true, temperature: 0.3 })
  await profile.handler('switch base', ctx)
  expect(client.engine.getConfig()).toMatchObject({ requireToolApproval: false, temperature: undefined, permissionMode: 'ask' })
  expect(client.engine.getPermissionManager().getMode()).toBe('default')
})

it('keeps explicit plan and rules policy stronger than permissive profile defaults', () => {
  const profile = { name: 'yolo', createdAt: 'now', permissionLevel: 'permissive' as const }
  expect(resolveProfilePermissionMode(profile, 'plan', 'default')).toBe('plan')
  expect(resolveProfilePermissionMode(profile, undefined, 'default')).toBe('bypassPermissions')
})
