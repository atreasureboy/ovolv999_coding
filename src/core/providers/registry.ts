import type { ModelInfo, ProviderId, ProviderInfo } from './types.js'

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    openAICompatible: true,
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    openAICompatible: false,
    models: ['claude-opus-4-1', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest'],
  },
  google: {
    id: 'google',
    name: 'Google AI',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_API_KEY',
    openAICompatible: false,
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash'],
  },
  xai: {
    id: 'xai',
    name: 'xAI (Grok)',
    baseURL: 'https://api.x.ai/v1',
    apiKeyEnv: 'XAI_API_KEY',
    openAICompatible: true,
    models: ['grok-4', 'grok-4-fast', 'grok-2-1212', 'grok-code-fast-1'],
  },
  openrouter: {
    id: 'openrouter',
    name: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    openAICompatible: true,
  },
  together: {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    apiKeyEnv: 'TOGETHER_API_KEY',
    openAICompatible: true,
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    openAICompatible: true,
    models: ['llama-3.3-70b-versatile', 'mixtral-8x7b-32768'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    openAICompatible: true,
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  ollama: {
    id: 'ollama',
    name: 'Ollama (local)',
    baseURL: 'http://localhost:11434/v1',
    openAICompatible: true,
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    apiKeyEnv: 'MISTRAL_API_KEY',
    openAICompatible: true,
  },
  cohere: {
    id: 'cohere',
    name: 'Cohere',
    baseURL: 'https://api.cohere.ai/v1',
    apiKeyEnv: 'COHERE_API_KEY',
    openAICompatible: true,
  },
  perplexity: {
    id: 'perplexity',
    name: 'Perplexity',
    baseURL: 'https://api.perplexity.ai',
    apiKeyEnv: 'PPLX_API_KEY',
    openAICompatible: true,
  },
  unknown: {
    id: 'unknown',
    name: 'Unknown',
    openAICompatible: true,
  },
}

export const MODELS: ModelInfo[] = [
  {
    id: 'gpt-4o', name: 'GPT-4o', provider: 'openai',
    contextWindow: 128_000, supportsVision: true, supportsTools: true, supportsParallelTools: true,
    pricing: { inputPer1M: 2.5, outputPer1M: 10 },
  },
  {
    id: 'gpt-4o-mini', name: 'GPT-4o mini', provider: 'openai',
    contextWindow: 128_000, supportsVision: true, supportsTools: true, supportsParallelTools: true,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6 },
  },
  {
    id: 'o1', name: 'o1', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 15, outputPer1M: 60 },
  },
  {
    id: 'o1-mini', name: 'o1 mini', provider: 'openai',
    contextWindow: 128_000, supportsReasoning: true,
    pricing: { inputPer1M: 3, outputPer1M: 12 },
  },
  {
    id: 'o3', name: 'o3', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 10, outputPer1M: 40 },
  },
  {
    id: 'o3-mini', name: 'o3 mini', provider: 'openai',
    contextWindow: 200_000, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
  },
  {
    id: 'o4-mini', name: 'o4 mini', provider: 'openai',
    contextWindow: 200_000, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.1, outputPer1M: 4.4 },
  },

  {
    id: 'claude-opus-4-1', name: 'Claude Opus 4.1', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 15, outputPer1M: 75 },
  },
  {
    id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 1, outputPer1M: 5 },
  },
  {
    id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', provider: 'anthropic',
    contextWindow: 200_000, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },

  {
    id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 1.25, outputPer1M: 10 },
  },
  {
    id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true, supportsReasoning: true,
    pricing: { inputPer1M: 0.3, outputPer1M: 2.5 },
  },
  {
    id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', provider: 'google',
    contextWindow: 1_048_576, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 0.1, outputPer1M: 0.4 },
  },

  {
    id: 'grok-4', name: 'Grok 4', provider: 'xai',
    contextWindow: 256_000, supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15 },
  },
  {
    id: 'grok-4-fast', name: 'Grok 4 Fast', provider: 'xai',
    contextWindow: 100_000, supportsTools: true,
    pricing: { inputPer1M: 0.2, outputPer1M: 0.5 },
  },
  {
    id: 'grok-code-fast-1', name: 'Grok Code Fast 1', provider: 'xai',
    contextWindow: 256_000, supportsTools: true,
    pricing: { inputPer1M: 0.2, outputPer1M: 1.5 },
  },
  {
    id: 'grok-2-1212', name: 'Grok 2 (1212)', provider: 'xai',
    contextWindow: 131_072, supportsVision: true, supportsTools: true,
    pricing: { inputPer1M: 2, outputPer1M: 10 },
  },

  {
    id: 'deepseek-chat', name: 'DeepSeek V3', provider: 'deepseek',
    contextWindow: 64_000, supportsTools: true,
    pricing: { inputPer1M: 0.27, outputPer1M: 1.1 },
  },
  {
    id: 'deepseek-reasoner', name: 'DeepSeek R1', provider: 'deepseek',
    contextWindow: 64_000, supportsReasoning: true,
    pricing: { inputPer1M: 0.55, outputPer1M: 2.19 },
  },

  {
    id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', provider: 'groq',
    contextWindow: 128_000, supportsTools: true,
    pricing: { inputPer1M: 0.59, outputPer1M: 0.79 },
  },
]

export const MODEL_INDEX = new Map<string, ModelInfo>()
for (const m of MODELS) MODEL_INDEX.set(m.id, m)
