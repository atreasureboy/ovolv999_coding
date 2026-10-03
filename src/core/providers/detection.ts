import { MODEL_INDEX, PROVIDERS } from './registry.js'
import type { ProviderId } from './types.js'

type DetectionRule = readonly [ProviderId, (value: string) => boolean]

const MODEL_RULES: readonly DetectionRule[] = [
  ['anthropic', model => model.includes('claude') || model.startsWith('anthropic/')],
  ['google', model => model.includes('gemini') || model.startsWith('google/')],
  ['xai', model => model.includes('grok') || model.startsWith('xai/')],
  ['deepseek', model => model.includes('deepseek') || model.startsWith('deepseek/')],
  ['groq', model => model.startsWith('llama-') || model.startsWith('mixtral-') || model.startsWith('groq/')],
  ['openrouter', model => model.startsWith('openrouter/')],
  ['mistral', model => model.includes('mistral') || model.includes('codestral') || model.includes('magistral')],
  ['cohere', model => model.includes('command-r') || model.includes('command-a')],
  ['perplexity', model => model.startsWith('perplexity/')],
  ['openai', model => ['gpt', 'o1', 'o3', 'o4', 'text-', 'davinci', 'chatgpt'].some(prefix => model.startsWith(prefix))],
]

const BASE_URL_RULES: readonly DetectionRule[] = [
  ['openai', url => url.includes('api.openai.com')],
  ['anthropic', url => url.includes('api.anthropic.com')],
  ['google', url => url.includes('generativelanguage.googleapis.com') || url.includes('gemini')],
  ['xai', url => url.includes('api.x.ai') || url.includes('xai')],
  ['openrouter', url => url.includes('openrouter.ai')],
  ['together', url => url.includes('api.together.xyz')],
  ['groq', url => url.includes('api.groq.com') || url.includes('groq')],
  ['deepseek', url => url.includes('api.deepseek.com') || url.includes('deepseek')],
  ['ollama', url => url.includes('localhost:11434') || url.includes('ollama')],
  ['mistral', url => url.includes('api.mistral.ai')],
  ['cohere', url => url.includes('api.cohere.ai') || url.includes('cohere')],
  ['perplexity', url => url.includes('api.perplexity.ai') || url.includes('perplexity')],
]

function matchProvider(value: string, rules: readonly DetectionRule[]): ProviderId | null {
  const normalized = value.toLowerCase()
  return rules.find(([, matches]) => matches(normalized))?.[0] ?? null
}

export function detectProviderFromModel(model: string): ProviderId {
  return matchProvider(model, MODEL_RULES) ?? MODEL_INDEX.get(model)?.provider ?? 'unknown'
}

export function detectProviderFromBaseURL(baseURL?: string): ProviderId | null {
  return baseURL ? matchProvider(baseURL, BASE_URL_RULES) : null
}

export function detectProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ProviderId | null {
  return Object.values(PROVIDERS).find(provider => provider.apiKeyEnv && env[provider.apiKeyEnv])?.id ?? null
}

export function detectProvider(input: { model?: string; baseURL?: string; env?: NodeJS.ProcessEnv }): ProviderId {
  const fromModel = input.model ? detectProviderFromModel(input.model) : 'unknown'
  if (fromModel !== 'unknown') return fromModel
  return detectProviderFromBaseURL(input.baseURL) ?? detectProviderFromEnv(input.env) ?? 'unknown'
}
