export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'openrouter'
  | 'together'
  | 'groq'
  | 'deepseek'
  | 'ollama'
  | 'mistral'
  | 'cohere'
  | 'perplexity'
  | 'unknown'

export interface ModelInfo {
  
  id: string
  
  name: string
  
  provider: ProviderId
  
  contextWindow: number
  
  maxOutputTokens?: number
  
  pricing: {
    inputPer1M: number
    outputPer1M: number
  }
  
  supportsVision?: boolean
  
  supportsTools?: boolean
  
  supportsParallelTools?: boolean
  
  supportsReasoning?: boolean
}

export interface ProviderInfo {
  id: ProviderId
  name: string
  
  baseURL?: string
  
  apiKeyEnv?: string
  
  openAICompatible: boolean
  
  models?: string[]
}
