import type { OpenAIMessage } from '../types.js'

export const ASCII_CHARS_PER_TOKEN = 3.5

export const NON_ASCII_CHARS_PER_TOKEN = 0.5

export function estimateTextTokens(text: string | null | undefined): number {
  if (!text) return 0
  let asciiChars = 0
  let nonAsciiChars = 0
  for (const ch of text) {
    if (ch.charCodeAt(0) <= 0x7F) {
      asciiChars++
    } else {
      nonAsciiChars++
    }
  }
  return asciiChars / ASCII_CHARS_PER_TOKEN + nonAsciiChars / NON_ASCII_CHARS_PER_TOKEN
}

export function estimateTokens(messages: OpenAIMessage[]): number {
  let tokens = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      tokens += estimateTextTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) tokens += part.type === 'text' ? estimateTextTokens(part.text) : 1024
    } else if (msg.content === null) {
      tokens += 1
    }
    tokens += 4 + Math.ceil(msg.role.length / ASCII_CHARS_PER_TOKEN)
    if (msg.tool_calls) {
      tokens += estimateTextTokens(JSON.stringify(msg.tool_calls)) + 1
    }
    if (msg.name) tokens += 1 + Math.ceil(msg.name.length / ASCII_CHARS_PER_TOKEN)
    if (msg.tool_call_id) tokens += 1 + Math.ceil(msg.tool_call_id.length / ASCII_CHARS_PER_TOKEN)
    tokens += 4
  }
  return Math.ceil(tokens)
}

export function estimateToolDefinitionTokens(
  toolDefs: ReadonlyArray<unknown> | undefined | null,
): number {
  if (!toolDefs || toolDefs.length === 0) return 0
  let tokens = 1
  for (const def of toolDefs) {
    tokens += estimateTextTokens(JSON.stringify(def))
  }
  return Math.ceil(tokens)
}
