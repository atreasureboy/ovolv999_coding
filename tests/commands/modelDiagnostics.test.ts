import { afterEach, expect, it, vi } from 'vitest'
import { diagnosticsCommands } from '../../src/commands/diagnosticsCommands.js'
import { CostTracker } from '../../src/core/costTracker.js'
import type { SlashCommandContext } from '../../src/commands/index.js'

afterEach(() => vi.unstubAllEnvs())

it('diagnoses the effective Anthropic runtime rather than unrelated OpenAI environment', async () => {
  vi.stubEnv('OPENAI_API_KEY', '')
  vi.stubEnv('OPENAI_BASE_URL', 'https://unrelated.invalid/v1')
  const config = { model: 'native', modelProtocol: 'anthropic', apiKey: 'runtime-secret-key', baseURL: 'https://api.anthropic.com/v1', cwd: process.cwd() }
  const context = { cwd: process.cwd(), history: [], engine: { getConfig: () => config, getModel: () => 'native', getCostTracker: () => new CostTracker(), isPlanMode: () => false, getFileHistory: () => null, getBackgroundTaskManager: () => ({ listTasks: () => [] }) } } as unknown as SlashCommandContext
  const result = await diagnosticsCommands.find(command => command.name === 'doctor')!.handler('', context)
  expect(result).toHaveProperty('value', expect.stringContaining('Provider protocol: anthropic'))
  expect(result).toHaveProperty('value', expect.stringContaining('API key: set'))
  expect(result).toHaveProperty('value', expect.stringContaining('https://api.anthropic.com/v1'))
  expect(result).not.toHaveProperty('value', expect.stringContaining('NOT SET'))
  expect(result).not.toHaveProperty('value', expect.stringContaining('unrelated.invalid'))
})
