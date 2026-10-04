import type OpenAI from 'openai'
import { createHash } from 'node:crypto'
import type { OpenAIMessage } from './types.js'
import { safeHistoryStart } from './messageGroups.js'
import { MODEL_MAX_CONTEXT_TOKENS } from './compact/budget.js'
import { estimateTokens } from './compact/tokens.js'

export { MODEL_MAX_CONTEXT_TOKENS, UNKNOWN_MODEL_CONTEXT_TOKENS, MAX_OUTPUT_TOKENS_DEFAULT, KNOWN_MODEL_CONTEXT_WINDOWS, clampMaxOutputTokens, effectiveInputBudget, isFinitePositiveInteger, resolveContextWindow } from './compact/budget.js'
export { ASCII_CHARS_PER_TOKEN, NON_ASCII_CHARS_PER_TOKEN, estimateTextTokens, estimateTokens, estimateToolDefinitionTokens } from './compact/tokens.js'

export function isAbort(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!err) return false
  const e = err as { name?: unknown; message?: unknown }
  if (e.name === 'AbortError') return true
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (msg.startsWith('aborted') || msg.startsWith('this operation was aborted')) return true
  if (msg.includes('request was aborted')) return true
  return false
}

// Percentage-based thresholds — the single source of truth for context pressure
export const CONTEXT_WARN_PCT    = 0.70   // 70%  → display yellow warning
export const CONTEXT_COMPACT_PCT = 0.85   // 85%  → force auto-compact (LLM summarization)

// microCompact — lightweight pre-compact that clears old tool results WITHOUT
// an LLM call. Runs at a lower threshold than full compact, buying headroom
// cheaply. Inspired by Claude Code's microCompact.
export const CONTEXT_MICROCOMPACT_PCT = 0.50  // 50%  → clear old tool results
const KEEP_RECENT_TOOL_RESULTS = 6     // keep the N most recent tool results
const CLEARED_PLACEHOLDER = '[Old tool result content cleared — re-run the tool if needed]'

// Tools whose results are safe to clear (they can be re-fetched).
// State-mutating tools (Write, Edit) are NOT compactable — their results
// are small and meaningful (success/failure confirmation).
const COMPACTABLE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Bash',
])

/** Compression strategy selected based on context pressure */
export type CompressionStrategy = 'proportional' | 'priority' | 'aggressive'

/** Determine compression strategy from usage fraction */
export function getCompressionStrategy(pct: number): CompressionStrategy {
  if (pct > 0.9) return 'aggressive'
  if (pct > 0.85) return 'priority'
  return 'proportional'
}

// Keep this many recent messages verbatim after compaction
const KEEP_RECENT_MESSAGES = 8

// Reserve tokens for the summary output itself
const SUMMARY_OUTPUT_RESERVE = 4_000

// ── Context state ────────────────────────────────────────────────────────────

export interface ContextState {
  /** Estimated current token count */
  currentTokens: number
  /** Model maximum context window */
  maxTokens: number
  /** Usage fraction 0–1 */
  pct: number
  /** True when ≥ CONTEXT_MICROCOMPACT_PCT — clear old tool results (no LLM call) */
  shouldMicroCompact: boolean
  /** True when ≥ CONTEXT_WARN_PCT — show a yellow warning */
  shouldWarn: boolean
  /** True when ≥ CONTEXT_COMPACT_PCT — trigger auto-compact immediately */
  shouldCompact: boolean
  /** Compression strategy based on current pressure */
  strategy: CompressionStrategy
}

/**
 * Calculate current context usage and determine whether to warn or compact.
 */
export function calculateContextState(
  messages: OpenAIMessage[],
  maxTokens: number = MODEL_MAX_CONTEXT_TOKENS,
): ContextState {
  const currentTokens = estimateTokens(messages)
  const pct = currentTokens / maxTokens
  return {
    currentTokens,
    maxTokens,
    pct,
    shouldMicroCompact: pct >= CONTEXT_MICROCOMPACT_PCT,
    shouldWarn:   pct >= CONTEXT_WARN_PCT,
    shouldCompact: pct >= CONTEXT_COMPACT_PCT,
    strategy: getCompressionStrategy(pct),
  }
}

// ── Compact prompt ──────────────────────────────────

const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
Do NOT use any tools. Your entire response must be a plain text summary.
Tool calls will be IGNORED — you have one turn to produce text.

`

const SUMMARY_SYSTEM_PROMPT = `${NO_TOOLS_PREAMBLE}You are summarizing a conversation between a user and an AI coding assistant.

Your summary will replace the full conversation history. The assistant must be able to continue the conversation from your summary with complete context.

Before writing the summary, analyze the conversation in <analysis> tags:
1. Go through each message chronologically
2. Identify: user requests, decisions made, files modified, commands run, errors encountered and fixed
3. Note any explicit user feedback or corrections
4. Identify what is still in progress or incomplete

Then write the summary in <summary> tags with these sections:

## Task Overview
What the user asked for and the overall goal.

## All User Messages
List ALL user messages (excluding tool results) verbatim or closely paraphrased. This preserves user feedback, changing requirements, and corrections across compaction. Never omit a user message.

## Work Completed
- Files created/modified (with paths and key changes)
- Commands run and their outcomes
- Problems solved and how

## Errors and Fixes
Any errors encountered and how they were resolved. Include the error message and the fix applied.

## Current State
What has been done, what is working, what is still pending.

## Key Context
Important decisions, patterns, constraints, or user preferences to remember.
Include relevant code snippets, function signatures, or file contents that are critical for continuing.

## Next Steps
What needs to be done next (if anything is incomplete). If the user's last message contained a specific request, quote it verbatim here.

IMPORTANT: Do NOT call any tools. Respond with TEXT ONLY.`

/**
 * Extract content between tags, stripping the analysis scratchpad.
 */
function extractSummary(text: string): string {
  // Try to get <summary>...</summary>
  const summaryMatch = text.match(/<summary>([\s\S]*?)<\/summary>/i)
  if (summaryMatch?.[1]) {
    return summaryMatch[1].trim()
  }

  // Fall back: strip <analysis> block and return the rest
  return text
    .replace(/<analysis>[\s\S]*?<\/analysis>/i, '')
    .trim()
}

function boundedPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const marker = ` ...[truncated; original ${text.length} chars]... `
  const remaining = Math.max(0, maxChars - marker.length)
  const head = Math.ceil(remaining / 2)
  const tail = remaining - head
  return text.slice(0, head) + marker + (tail ? text.slice(-tail) : '')
}

function attachmentReference(url: string | undefined, location = ''): string {
  if (!url) return `[IMAGE ATTACHMENT${location}: reference unavailable]`
  if (/^data:/i.test(url)) {
    const mime = /^data:([^;,]+)/i.exec(url)?.[1] ?? 'unknown'
    const hash = createHash('sha256').update(url).digest('hex')
    return `[IMAGE ATTACHMENT${location}: mime=${boundedPreview(mime, 100)} sha256=${hash}; inline data omitted; no retrievable URL supplied]`
  }
  return `[IMAGE ATTACHMENT${location}: original reference=${boundedPreview(url, 512)}; access not verified]`
}

function omitInlineImages(text: string): string {
  return text.replace(/\bdata:image\\?\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[a-z0-9+/=_%\\-]+/gi, url => attachmentReference(url.replace(/\\\//g, '/')))
}

function salientArgumentFields(value: unknown): string {
  const fields: string[] = []
  let visited = 0
  let truncated = false
  const relevant = (key: string): boolean => /(?:^|_)(?:paths?|files?|cwd|directory|worktree|target|destination|purpose|description|reason|objective|task|prompt|command|url|uri)(?:$|_)/.test(key.replace(/[A-Z]/g, letter => '_' + letter.toLowerCase()))
  const visit = (current: unknown, path: string, depth: number): void => {
    visited++
    if (depth > 8 || visited > 4096 || fields.length >= 64) {
      truncated = true
      return
    }
    if (!current || typeof current !== 'object') return
    for (const key in current) {
      if (!Object.hasOwn(current, key)) continue
      if (visited >= 4096 || fields.length >= 64) { truncated = true; break }
      const child = (current as Record<string, unknown>)[key]
      const childPath = path ? `${path}.${key}` : key
      if (relevant(key)) fields.push(`${boundedPreview(childPath, 160)}: ${boundedPreview(JSON.stringify(child), 600)}`)
      visit(child, childPath, depth + 1)
    }
  }
  visit(value, '', 0)
  if (truncated) fields.push('[retained-field scan truncated]')
  return fields.join('\n')
}

function serializeToolArguments(argumentsText: string): string {
  const sanitized = omitInlineImages(argumentsText)
  const maxChars = 4000
  if (sanitized.length <= maxChars) return sanitized
  let fields = ''
  try {
    fields = boundedPreview(salientArgumentFields(JSON.parse(sanitized)), 1800)
  } catch (error) { void error }
  const prefix = `[arguments truncated; original ${argumentsText.length} chars]${fields ? '\n[retained fields]\n' + fields : ''}\n[argument preview]\n`
  return prefix + boundedPreview(sanitized, maxChars - prefix.length)
}

export function serializeCompactionInput(messages: readonly OpenAIMessage[]): string {
  const parts: string[] = []
  for (const [messageIndex, msg] of messages.entries()) {
    const role = msg.role.toUpperCase()
    const content = typeof msg.content === 'string'
      ? omitInlineImages(msg.content)
      : Array.isArray(msg.content)
        ? msg.content.map((part, partIndex) => part.type === 'text'
          ? omitInlineImages(part.text ?? '')
          : part.type === 'image_url'
            ? attachmentReference(part.image_url?.url, ` message=${messageIndex + 1} part=${partIndex + 1}`)
            : '').filter(Boolean).join('\n')
        : ''
    if (msg.role === 'tool') {
      const identity = msg.tool_call_id ? `; tool_call_id=${msg.tool_call_id}` : ''
      parts.push(`[TOOL RESULT: ${msg.name ?? '?'}${identity}]: ${boundedPreview(content, 500)}`)
    } else if (content) {
      parts.push(`[${role}]: ${content}`)
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const calls = msg.tool_calls
        .map(tc => `  → ${tc.function.name}(${serializeToolArguments(tc.function.arguments)}) [tool_call_id=${tc.id}]`)
        .join('\n')
      parts.push(`[ASSISTANT tool calls]:\n${calls}`)
    }
  }
  return parts.join('\n\n')
}

export function serializeMessages(messages: OpenAIMessage[]): string {
  return serializeCompactionInput(messages)
}

export interface CompactResult {
  compacted: boolean
  messages: OpenAIMessage[]
  summaryTokens: number
  originalTokens: number
}

/**
 * Pick a split index so that `messages.slice(splitPoint)` is a safe leading
 * window to send to the OpenAI chat API. "Safe" means:
 *
 *   1. `messages[splitPoint]` is not `role: 'tool'` (orphan tool result).
 *   2. If `messages[splitPoint]` is `role: 'assistant'` carrying
 *      `tool_calls`, EVERY `tool_call.id` it names must appear on a
 *      `role: 'tool'` message SOMEWHERE inside the recent window. An
 *      orphan assistant tool_call (assistant asks for `Bash`, but the
 *      `Bash` result was dropped because it was "old") makes the API
 *      reject the request.
 *
 * Strategy: start at `messages.length - KEEP_RECENT_MESSAGES`. Walk FORWARD
 * past any leading invalid boundary (orphan tool / orphan assistant
 * tool_call). If we walk off the end (no safe forward point), walk
 * BACKWARD from the end and return the largest safe index we can find.
 *
 * Returns `messages.length` only when NO safe boundary exists — caller
 * treats that as "nothing usable to keep verbatim" and falls back to the
 * non-compacted path.
 *
 * Pure function — exposed for tests so the safety contract can be locked
 * down without spinning up a fake OpenAI client.
 */
export function computeSafeSplitPoint(messages: OpenAIMessage[]): number {
  return safeHistoryStart(messages, KEEP_RECENT_MESSAGES)
}

/**
 * Compact the conversation by summarizing older messages.
 * The engine gates this call — by the time we're here, compaction is needed.
 * Returns new (smaller) messages array.
 *
 * `signal` (optional AbortSignal) is forwarded to the OpenAI completion
 * call so the user can cancel a long-running summary with ESC / Ctrl+C /
 * a 10-minute hard deadline. The cancellation contract is:
 *
 *   - `signal.aborted` at entry: throw immediately (treat as
 *     cancellation, not a silent failure).
 *   - The create() promise rejects with an AbortError (recognised by
 *     `err.name === 'AbortError'` OR message includes "aborted" /
 *     "Request was aborted"): RE-THROW. Aborts must NEVER be silently
 *     swallowed — that would strand the engine waiting on a dead
 *     summary request while the user thinks their ESC key worked.
 *   - Any OTHER failure (network error, 429, malformed-response):
 *     swallow and return `compacted: false` so the engine can continue
 *     with the original messages.
 */
export async function maybeCompact(
  client: OpenAI,
  model: string,
  messages: OpenAIMessage[],
  signal?: AbortSignal,
): Promise<CompactResult> {
  // Fast-path: caller already aborted before we started the
  // summarization request — do not waste an API call.
  if (signal?.aborted) {
    throw new Error('maybeCompact: aborted before summarization request')
  }

  const originalTokens = estimateTokens(messages)

  // Keep the most recent messages verbatim — they're the freshest context.
  // CRITICAL: The recent window must START with a valid message type:
  //   - 'user' or 'assistant' (with or without tool_calls)
  //   - NEVER start with 'tool' (orphan result → API 400)
  //   - NEVER start with 'assistant' carrying tool_calls unless every
  //     matching tool result is ALSO inside the recent window — otherwise
  //     the assistant message is an orphan tool_call and the API rejects
  //     the request with a 400 ("messages must alternate between tool /
  //     assistant after the first user").
  //
  // We compute the split point once with `computeSafeSplitPoint`, which
  // guarantees both invariants for messages.slice(splitPoint). The legacy
  // code only filtered the orphan-tool case; orphan assistant-tool_calls
  // could slip through and break the next LLM call.
  const splitPoint = computeSafeSplitPoint(messages)
  const recentMessages = messages.slice(splitPoint)
  const olderMessages = messages.slice(0, splitPoint)

  if (olderMessages.length === 0 || messages.length < KEEP_RECENT_MESSAGES * 2) {
    // Not enough messages to compact meaningfully — return original.
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build the summarization request
  const conversationText = serializeCompactionInput(olderMessages)
  const userPrompt = `Please summarize the following conversation:\n\n${conversationText}`

  let summaryText: string
  try {
    const response = await client.chat.completions.create(
      {
        model,
        messages: [
          { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        max_tokens: SUMMARY_OUTPUT_RESERVE,
        // No tools — we explicitly don't want tool calls here
      },
      // Forward the caller's AbortSignal so ESC / Ctrl+C / a 10-minute
      // hard deadline can interrupt the summarization. Without this,
      // auto-compact could park indefinitely after a user cancel and
      // the engine would silently fall through to `compacted: false`.
      signal ? { signal } : undefined,
    )
    const choice = response.choices[0]
    if (choice?.finish_reason !== 'stop' || choice.message.tool_calls?.length) {
      return { compacted: false, messages, summaryTokens: 0, originalTokens }
    }
    summaryText = choice.message.content ?? ''
  } catch (err) {
    // Cancellation contract: aborts are NEVER silently swallowed. The
    // engine relies on the throw to surface the cancellation up through
    // its own catch and into the user-facing `result.reason = 'error'`
    // path. Other failures (network blip, 429, malformed-response)
    // keep the legacy "return compacted:false" behaviour so the engine
    // can continue with the original messages.
    if (isAbort(err, signal)) {
      throw err
    }
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  const summary = extractSummary(summaryText)
  if (!summary) {
    return { compacted: false, messages, summaryTokens: 0, originalTokens }
  }

  // Build compacted history: summary message + recent verbatim messages
  const summaryContent = `[CONVERSATION SUMMARY — previous context compacted]\n\n${summary}`

  const summaryMessage: OpenAIMessage = {
    role: 'system', source: 'summary',
    content: summaryContent,
  }

  const syntheticAssistantAck: OpenAIMessage = {
    role: 'assistant',
    content: `I've reviewed the conversation summary and have the context needed to continue.`,
  }

  const compactedMessages: OpenAIMessage[] = [
    summaryMessage,
    syntheticAssistantAck,
    ...recentMessages,
  ]

  const summaryTokens = estimateTokens(compactedMessages)

  return {
    compacted: true,
    messages: compactedMessages,
    summaryTokens,
    originalTokens,
  }
}

// ── microCompact ────────────────────────────────────────────────────────────

export interface MicroCompactResult {
  compacted: boolean
  messages: OpenAIMessage[]
  tokensBefore: number
  tokensAfter: number
  toolsCleared: number
}

/**
 * Lightweight context reduction — clears old tool result content WITHOUT
 * calling the LLM. Replaces compactable tool results (Read, Grep, Glob,
 * Bash, Web*) that are older than KEEP_RECENT_TOOL_RESULTS with a placeholder.
 *
 * Inspired by Claude Code's microCompact. This is a first-line defense that
 * runs at 50% context pressure — much cheaper and faster than the full
 * LLM-summarization compact (maybeCompact) which runs at 85%.
 *
 * The tool results can be re-fetched by the LLM if needed (re-run Read/Grep/etc).
 * State-mutating tools (Write, Edit, Agent) are NOT cleared — their results
 * are small and meaningful.
 *
 * Mutates messages in place (like maybeCompact does).
 */
function unchangedMicroCompact(messages: OpenAIMessage[], tokens = estimateTokens(messages)): MicroCompactResult {
  return { compacted: false, messages, tokensBefore: tokens, tokensAfter: tokens, toolsCleared: 0 }
}

export function microCompact(messages: OpenAIMessage[]): MicroCompactResult {
  const tokensBefore = estimateTokens(messages)
  let recentResults = 0
  let toolsCleared = 0
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role !== 'tool' || !message.name || !COMPACTABLE_TOOLS.has(message.name) || message.content === CLEARED_PLACEHOLDER) continue
    if (recentResults++ < KEEP_RECENT_TOOL_RESULTS) continue
    if (typeof message.content !== 'string' || message.content.length <= CLEARED_PLACEHOLDER.length) continue
    messages[index] = { ...message, content: CLEARED_PLACEHOLDER }
    toolsCleared++
  }
  if (toolsCleared === 0) return unchangedMicroCompact(messages, tokensBefore)
  return { compacted: true, messages, tokensBefore, tokensAfter: estimateTokens(messages), toolsCleared }
}

/**
 * Time-based micro-compact: if enough wall-clock time has passed since the
 * last assistant message, the prompt cache has likely expired — the next
 * LLM call will re-process the full prefix anyway, so it's "free" to clear
 * old tool results NOW (they're going to be re-sent regardless). Inspired
 * by Claude Code's time-based microCompact trigger.
 *
 * Contract:
 *   - If `lastAssistantTimestamp` is undefined OR the gap to `now` is
 *     below `thresholdMs`, return `{ compacted: false, ... }` without
 *     touching the messages. This is the conservative no-op path.
 *   - Otherwise delegate to {@link microCompact} (which has the actual
 *     clearing policy — keep N most recent, replace the rest with a
 *     placeholder). The time check is just a gate.
 *
 * `now` is injectable so tests can pin wall-clock without monkey-patching
 * Date.now. `thresholdMs` defaults to 5 minutes (the same value Claude
 * Code uses; it's a deliberate constant, not a per-deployment knob, to
 * match the cache-warmth model).
 *
 * Pure function: mutates `messages` only when delegating to microCompact,
 * and only when the underlying check decides to clear results.
 */
export function maybeTimeBasedMicroCompact(
  messages: OpenAIMessage[],
  lastAssistantTimestamp: number | undefined,
  now: number = Date.now(),
  thresholdMs: number = 5 * 60 * 1000,
): MicroCompactResult {
  if (lastAssistantTimestamp === undefined || now - lastAssistantTimestamp < thresholdMs) return unchangedMicroCompact(messages)
  return microCompact(messages)
}
