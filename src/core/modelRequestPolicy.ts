import type OpenAI from 'openai'

export interface ModelRequestOptions extends OpenAI.RequestOptions {
  reasoningPolicy?: 'configured' | 'omit'
}

export function auxiliaryModelOptions(options: OpenAI.RequestOptions = {}): ModelRequestOptions {
  return { ...options, reasoningPolicy: 'omit' }
}
