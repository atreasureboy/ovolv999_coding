import { getModelInfo } from '../providers.js'

export const MODEL_MAX_CONTEXT_TOKENS = 200_000
export const UNKNOWN_MODEL_CONTEXT_TOKENS = 64_000

export const MAX_OUTPUT_TOKENS_DEFAULT = 8192

export function clampMaxOutputTokens(
  maxOutput: number | undefined | null,
  contextWindow: number,
): number {
  const requested = isFinitePositiveInteger(maxOutput)
    ? maxOutput
    : MAX_OUTPUT_TOKENS_DEFAULT
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) {
    return Math.max(1, requested)
  }
  const halfWindow = Math.max(1, Math.floor(contextWindow / 2))
  return Math.max(1, Math.min(requested, halfWindow))
}

export function isFinitePositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value > 0
  )
}

export function effectiveInputBudget(
  contextWindow: number,
  maxOutput: number | undefined | null,
): number {
  const reservedOutput = clampMaxOutputTokens(maxOutput, contextWindow)
  const input = contextWindow - reservedOutput
  return Math.max(1, input)
}

export const KNOWN_MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [pattern: RegExp, window: number]> = [
  [/^claude-(?:opus|sonnet|haiku)-?4/i, 200_000],
  [/^claude-3-7-sonnet/i, 200_000],
  [/^claude-3-5-(?:sonnet|haiku)/i, 200_000],
  [/^claude-3-(?:opus|sonnet|haiku)/i, 200_000],
  [/^claude-instant/i, 100_000],
  [/^o[1-9](?:-mini|-nano)?(?:-preview|-pro)?$/i, 200_000],
  [/^gpt-5/i, 400_000],
  [/^chatgpt-4o/i, 128_000],
  [/^gpt-4o(?:-mini)?/i, 128_000],
  [/^gpt-4-turbo/i, 128_000],
  [/^gpt-4(?:-vision)?$/i, 8_192],
  [/^gpt-4-32k/i, 32_768],
  [/^gpt-3\.5-turbo-16k/i, 16_385],
  [/^gpt-3\.5-turbo/i, 4_096],
  [/^deepseek-(?:reasoner|chat)/i, 64_000],
  [/^qwen(?:-(?:plus|turbo|max|long))?/i, 32_768],
  [/^llama-3\.1(?:-\d+b)?/i, 128_000],
  [/^llama-3(?:\.\d+)?(?:-\d+b)?$/i, 8_192],
]

export function resolveContextWindow(model: string, override?: number): number {
  if (isFinitePositiveInteger(override)) {
    return override
  }
  if (typeof model !== 'string' || !model) return UNKNOWN_MODEL_CONTEXT_TOKENS
  const metadata = getModelInfo(model)
  if (metadata) return metadata.contextWindow

  let bestMatch: readonly [RegExp, number] | undefined
  for (const entry of KNOWN_MODEL_CONTEXT_WINDOWS) {
    if (entry[0].test(model)) {
      if (!bestMatch || entry[0].source.length > bestMatch[0].source.length) {
        bestMatch = entry
      }
    }
  }
  return bestMatch?.[1] ?? UNKNOWN_MODEL_CONTEXT_TOKENS
}
