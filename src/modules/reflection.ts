/**
 * ReflectionModule — post-run knowledge extraction.
 *
 * After a Run completes, analyzes the conversation to extract:
 * - Success patterns → Semantic Memory (what worked)
 * - Failure patterns → Semantic Memory (what to avoid)
 *
 * Depends on: memory module (writes to SemanticMemory).
 * This is new functionality — not extracted from existing code.
 */

import type OpenAI from 'openai'
import type { OpenAIMessage } from '../core/types.js'
import type { AgentModule, ModuleBootResult, ModuleRunContext } from '../core/module.js'
import type { MemorySourceRef, SemanticMemory } from '../core/semanticMemory.js'
import type { EpisodicMemory } from '../core/episodicMemory.js'

const REFLECTION_SYSTEM_PROMPT = `You are a reflection engine. Analyze the agent run with its recorded outcome and verification status and extract reusable knowledge.

Output JSON with this structure:
{
  "knowledge": [
    {
      "content": "concise knowledge statement",
      "tags": ["relevant", "tags"],
      "confidence": 0.8,
      "source": "agent_inferred"
    }
  ]
}

Rules:
- Extract only genuinely reusable insights (not run-specific details)
- Preserve failures, incomplete outcomes and verification limits; never infer success from an assistant claim
- Max 3 knowledge entries per run
- Confidence 0.5-0.9 (be honest about uncertainty)
- If nothing worth remembering, return {"knowledge": []}
- Respond with JSON only, no prose`

const REFLECTION_MAX_TOKENS = 800

interface ReflectionKnowledge {
  content: string
  tags: string[]
  confidence: number
}

interface ReflectionAttribution {
  scope: 'run' | 'session'
  source: 'agent_inferred' | 'consolidation'
  outcome: string
  verification: string
  sourceRef?: MemorySourceRef
}

async function requestReflection(client: OpenAI, model: string, prompt: string, signal?: AbortSignal): Promise<ReflectionKnowledge[]> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: 'system', content: REFLECTION_SYSTEM_PROMPT }, { role: 'user', content: prompt }],
    temperature: 0,
    max_tokens: REFLECTION_MAX_TOKENS,
  }, { timeout: 30_000, signal, maxRetries: 0 })
  return parseReflection(response.choices[0]?.message?.content ?? '')
}

async function persistReflection(semantic: SemanticMemory, entries: ReflectionKnowledge[], attribution: ReflectionAttribution, signal?: AbortSignal): Promise<number> {
  signal?.throwIfAborted()
  let persisted = 0
  for (const entry of entries) {
    const result = await semantic.writeAsync({
      content: `[${attribution.scope} ${attribution.outcome}; verification ${attribution.verification}] ${entry.content}`,
      provenance: { status: 'unverified', claimedSource: attribution.source, outcome: attribution.outcome, verification: attribution.verification },
      tags: entry.tags,
      source: attribution.source,
      confidence: entry.confidence,
      timestamp: new Date().toISOString(),
      sourceRef: attribution.sourceRef,
    })
    if (result.persistence === 'persisted') persisted++
  }
  return persisted
}

export class ReflectionModule implements AgentModule {
  readonly name = 'reflection'
  readonly dependencies = ['memory']

  constructor(
    private client: OpenAI,
    private model: string,
    private semantic: SemanticMemory,
    private config: { planMode?: boolean; poor?: { enabled: boolean } },
  ) {}

  boot(): ModuleBootResult {
    return {}
  }

  onModelChange(model: string): void {
    this.model = model
  }

  async onComplete(ctx: ModuleRunContext): Promise<void> {
    if (this.config.poor?.enabled) return
    // Skip if the run was too short to yield useful insights
    const toolCallCount = ctx.messages.filter(m => m.role === 'tool').length
    if (toolCallCount < 3) return

    if (ctx.abortSignal?.aborted) return
    const outcome = ctx.turnResult.status ?? (ctx.turnResult.reason === 'error' ? 'failed' : 'unknown')
    const verification = ctx.turnResult.verification?.status ?? 'not_run'

    try {
      const conversationSummary = this.serializeForReflection(ctx.messages)

      const parsed = await requestReflection(this.client, ctx.model ?? this.model,
        `Analyze this agent run (outcome: ${outcome}; verification: ${verification}):\n\n${conversationSummary}`, ctx.abortSignal)
      const persisted = await persistReflection(this.semantic, parsed,
        { scope: 'run', source: 'agent_inferred', outcome, verification,
          sourceRef: ctx.sessionDir && ctx.turnResult.runId
            ? { sessionId: ctx.sessionDir, turnId: ctx.turnResult.runId, role: 'assistant' } : undefined }, ctx.abortSignal)

      if (parsed.length > 0) {
        ctx.eventLog?.append('memory_write', 'reflection', {
          entries: persisted,
          failedEntries: parsed.length - persisted,
          outcome,
          verification,
          module: 'reflection',
        })
      }
    } catch {
      // reflection failures must never break anything
    }
  }

  private serializeForReflection(messages: OpenAIMessage[]): string {
    const parts: string[] = []
    for (const msg of messages.slice(-30)) {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        parts.push(`[USER]: ${msg.content.slice(0, 200)}`)
      } else if (msg.role === 'assistant') {
        if (typeof msg.content === 'string' && msg.content) parts.push(`[ASSISTANT]: ${msg.content.slice(0, 200)}`)
        if (msg.tool_calls?.length) {
          const names = msg.tool_calls
            .map(tc => tc.function.name).join(', ')
          parts.push(`[TOOLS USED]: ${names}`)
        }
      } else if (msg.role === 'tool' && typeof msg.content === 'string') {
        parts.push(`[RESULT]: ${msg.content.slice(0, 100)}`)
      }
    }
    return parts.join('\n')
  }
}

/** Parse LLM reflection output into knowledge entries (standalone, not private) */
function parseReflection(output: string): ReflectionKnowledge[] {
  try {
    const parsed = JSON.parse(output) as {
      knowledge?: Array<{
        content: string
        tags?: string[]
        confidence?: number
      }>
    }
    return (parsed.knowledge ?? [])
      .filter(e => typeof e.content === 'string' && e.content.length > 10)
      .slice(0, 3)
      .map(e => ({
        content: e.content.slice(0, 500),
        tags: Array.isArray(e.tags) ? e.tags.filter(tag => typeof tag === 'string') : [],
        confidence: typeof e.confidence === 'number' && Number.isFinite(e.confidence) ? Math.min(0.9, Math.max(0.5, e.confidence)) : 0.5,
      }))
  } catch {
    return []
  }
}

// ── Session-level consolidation (AgentOS §8 Memory 整合) ──────────────────────

/**
 * Consolidate a session's episodic events into semantic memory.
 * Called at REPL exit to close the learning loop.
 *
 * Unlike per-turn reflection (which analyzes a single run), this summarizes
 * the entire session's activity and extracts durable knowledge.
 */
export async function consolidateSession(
  client: OpenAI,
  model: string,
  episodic: EpisodicMemory,
  semantic: SemanticMemory,
  poor?: { enabled: boolean },
  signal?: AbortSignal,
): Promise<{ episodes: number; knowledgeExtracted: number }> {
  if (poor?.enabled || signal?.aborted) {
    return { episodes: 0, knowledgeExtracted: 0 }
  }
  const episodes = episodic.recent(100)
  if (episodes.length < 5) {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }

  const sessionSummary = episodes.map((e, i) => {
    const icon = e.outcome === 'success' ? '✓' : '✗'
    return `${i + 1}. ${icon} ${e.toolName}: ${e.inputSummary.slice(0, 60)} → ${e.resultSummary.slice(0, 80)}`
  }).join('\n')

  try {
    const parsed = await requestReflection(client, model,
      `Summarize this entire coding session and extract durable knowledge:\n\n${sessionSummary}`, signal)
    const outcome = episodes.some(episode => episode.outcome !== 'success') ? 'contains_failures_or_incomplete_actions' : 'tool_successes_only'
    const persisted = await persistReflection(semantic, parsed,
      { scope: 'session', source: 'consolidation', outcome, verification: 'not_run' }, signal)

    return { episodes: episodes.length, knowledgeExtracted: persisted }
  } catch {
    return { episodes: episodes.length, knowledgeExtracted: 0 }
  }
}
