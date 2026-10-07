import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveApiEnvironment } from '../../src/cli/environment.js'

beforeEach(() => {
  for (const name of ['OPENAI_API_KEY', 'OPENAI_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'OVOGO_MODEL', 'OVOGO_MODEL_PROTOCOL']) vi.stubEnv(name, undefined)
})
afterEach(() => vi.unstubAllEnvs())

it('selects native Anthropic credentials when explicitly configured', () => {
  vi.stubEnv('OPENAI_API_KEY', 'openai-key')
  vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-key')
  vi.stubEnv('ANTHROPIC_MODEL', 'configured-claude')
  expect(resolveApiEnvironment('anthropic')).toMatchObject({ apiKey: 'anthropic-key', baseURL: 'https://api.anthropic.com/v1', provider: 'anthropic', model: 'configured-claude', protocol: 'anthropic' })
})

it('does not send OpenAI credentials to a configured Anthropic endpoint', () => {
  vi.stubEnv('OPENAI_API_KEY', 'openai-key')
  expect(resolveApiEnvironment('anthropic').apiKey).toBeUndefined()
  expect(resolveApiEnvironment('anthropic').model).toBe('')
})

it('preserves MiniMax compatibility unless native protocol is requested', () => {
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'minimax-key')
  vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.minimax.io/anthropic')
  expect(resolveApiEnvironment()).toMatchObject({ apiKey: 'minimax-key', baseURL: 'https://api.minimax.io/v1', provider: 'minimax', protocol: 'chat-completions' })
  expect(resolveApiEnvironment('anthropic')).toMatchObject({ baseURL: 'https://api.minimax.io/anthropic', protocol: 'anthropic' })
})

it('supports explicit Responses environment selection without inferring model prefixes', () => {
  vi.stubEnv('OPENAI_API_KEY', 'openai-key')
  vi.stubEnv('OVOGO_MODEL', 'opaque-model-name')
  vi.stubEnv('OVOGO_MODEL_PROTOCOL', 'responses')
  expect(resolveApiEnvironment()).toMatchObject({ protocol: 'responses', model: 'opaque-model-name', apiKey: 'openai-key' })
  vi.stubEnv('OVOGO_MODEL_PROTOCOL', 'invalid')
  expect(() => resolveApiEnvironment()).toThrow(/protocol/i)
})
