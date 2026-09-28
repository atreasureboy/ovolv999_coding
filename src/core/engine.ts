import { assertExecutionProfile, createProcessScope } from './executionBackend.js'
import { createModelGateway } from './modelGateway.js'
import { trimHistory, settleHistory } from './messageGroups.js'
/**
 * Think-Act-Observe Engine — with streaming output
 *
 * Key features:
 * 1. Parallel tool execution — read-only tools batched via Promise.all;
 *    state-mutating tools run serially.
 * 2. AbortController per turn — engine.abort() cancels in-flight API calls
 *    and tool executions.
 * 3. Plan mode — only read-only tools are exposed/executed.
 * 4. Hook callbacks around every tool call.
 * 5. Critic loop — every N iterations a lightweight LLM call reviews recent
 *    context for common failure modes and injects corrections.
 * 6. Context budget management — automatic compression with anchor preservation.
 *
 * Architecture:
 *   runTurn() orchestrates the high-level loop, delegating to:
 *     - buildSystemPrompt()        → compose system prompt
 *     - evaluateContextBudget()    → check token usage, compact if needed
 *     - maybeRunCritic()           → inject correction every N iterations
 *     - callLLM()                  → streaming LLM invocation
 *     - consumeStream()            → parse streamed response
 *     - scheduleToolCalls()        → partition + execute tool calls
 *     - executeToolCall()          → single tool execution
 */

import OpenAI from 'openai'
import { ThinkingTagFilter } from './thinkingTagFilter.js'
import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type {
  EngineConfig,
  OpenAIMessage,
  ContentPart,
  Tool,
  ToolContext,
  ToolResult,
  TurnResult,
  ToolDefinition,
} from './types.js'
import { createTools, findTool, getToolDefinitions } from '../tools/index.js'
import { getPlanModePrefix } from '../prompts/system.js'
import type { Renderer } from '../ui/renderer.js'
import {
  maybeCompact,
  microCompact,
  maybeTimeBasedMicroCompact,
  estimateTokens,
  estimateToolDefinitionTokens,
  getCompressionStrategy,
  CONTEXT_MICROCOMPACT_PCT,
  CONTEXT_WARN_PCT,
  CONTEXT_COMPACT_PCT,
  resolveContextWindow,
  clampMaxOutputTokens,
  effectiveInputBudget,
} from './compact.js'
import type { AgentModule, ModuleBootResult, ModuleBootContext } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { applyAgentToConfig } from './agentPresets.js'
import { filterToolsForSubAgent } from './agentToolFilter.js'
import { initializeRunStore, createRunContext, runOperation, quarantineRun, quarantineWorkspace, isWorkspaceQuarantined, withWorkspaceAccess, type RunContext } from './runContext.js'
import { normalizeOutcome, settleWithin, type VerificationEvidence } from './outcome.js'
import { createVerificationPlan, captureArtifactVersion, executeVerification } from './verification.js'
import {
  transitionQueryState,
  isTerminal,
  createBudgetTracker,
  checkTokenBudget,
  type QueryState,
} from './queryStateMachine.js'
import { CostTracker, type TokenUsage } from './costTracker.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import { FileHistory } from './fileHistory.js'
import { PermissionManager, checkRules } from './permissionSystem.js'
import { classifyCommandRisk } from './riskClassifier.js'
import { normalizeCJKInput } from './strings.js'

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_TOOL_RESULT_LENGTH = 20_000
/** Aggregate budget for all tool results in a single LLM response.
 * When the total exceeds this, the largest results are persisted to disk
 * individually until the aggregate fits. Prevents parallel tool calls
 * (e.g. 10× Grep returning 15K each = 150K total) from blowing context.
 * Inspired by claude-code-best's enforceToolResultBudget.
 */
const MAX_AGGREGATE_TOOL_RESULTS = 60_000

/**
 * Truncate or persist a tool result to stay within context budget.
 * Claude Code approach: large results → save to disk, inject preview + file path.
 */
function truncateToolResult(result: string, sessionDir?: string): string {
  if (result.length <= MAX_TOOL_RESULT_LENGTH) return result

  // Persist to disk if sessionDir available (saves context tokens)
  if (sessionDir) {
    try {
      const dir = join(sessionDir, 'tool-results')
      mkdirSync(dir, { recursive: true })
      const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
      const filePath = join(dir, fileName)
      writeFileSync(filePath, result, 'utf8')
      const preview = result.slice(0, 2000)
      return `${preview}\n\n[... Full output (${result.length} chars) saved to: ${filePath} ...]`
    } catch {
      // Fall through to truncation
    }
  }

  // Fallback: head + tail truncation
  const half = MAX_TOOL_RESULT_LENGTH / 2
  return (
    result.slice(0, half) +
    `\n\n[... ${result.length - MAX_TOOL_RESULT_LENGTH} chars truncated ...]\n\n` +
    result.slice(result.length - half)
  )
}

/**
 * Enforce an aggregate budget across all tool results in a single batch.
 * When the total character count exceeds MAX_AGGREGATE_TOOL_RESULTS,
 * the largest results are individually persisted to disk (replaced with
 * preview + file path) until the aggregate fits. Smaller-but-numerous
 * results that don't warrant disk persist are TRUNCATED in place to
 * head+tail — there is no fallback below MAX_TOOL_RESULT_LENGTH for the
 * disk path, so we must truncate medium-sized results in memory instead
 * of giving up.
 *
 * This solves BOTH:
 *   - "1 huge + 0 small" (one Grep returning 80K) — persist the giant
 *   - "10 medium each returning 15K = 150K total" — persists the biggest
 *     and truncates the rest so the aggregate actually fits.
 * Per-result truncation alone cannot catch the second case.
 *
 * Per-item cap: MAX_AGGREGATE_TOOL_RESULTS / item_count, floored at 1.
 * With this cap, once every item is at most itemTarget chars the
 * aggregate MUST fit (sum ≤ MAX_AGGREGATE_TOOL_RESULTS) — the loop's
 * exit predicate ("currentTotal ≤ MAX_AGGREGATE_TOOL_RESULTS") is then
 * guaranteed to fire, no matter how many items there are.
 *
 * Regression guard: the previous implementation had `break` when
 * finding a "small enough" item, exiting the loop on the FIRST medium
 * result and leaving the aggregate unchanged. Items with size between
 * (per-item budget) and MAX_TOOL_RESULT_LENGTH were not trimmed.
 *
 * Inspired by claude-code-best's enforceToolResultBudget.
 */
function enforceAggregateToolResultBudget(
  results: { content: string; tc: { id: string; name: string } }[],
  sessionDir?: string,
): void {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0)
  if (totalChars <= MAX_AGGREGATE_TOOL_RESULTS) return
  if (results.length === 0) return

  // Per-item cap: distribute the aggregate budget evenly across the
  // items. Once every item is at most `itemTarget` chars the aggregate
  // MUST fit (and the break-on-budget predicate fires).
  const itemTarget = Math.max(1, Math.floor(MAX_AGGREGATE_TOOL_RESULTS / results.length))

  // Sort by size descending — work on the largest first so each shrink
  // buys the most headroom.
  const indexed = results.map((r, i) => ({ r, i, size: r.content.length }))
  indexed.sort((a, b) => b.size - a.size)

  let currentTotal = totalChars
  for (const item of indexed) {
    if (currentTotal <= MAX_AGGREGATE_TOOL_RESULTS) break

    // Already small enough — leave alone. Regression guard: the legacy
    // code `break`-ed here, which prevented the rest of the items from
    // being shrunk. `continue` lets the loop proceed to trim the others.
    if (item.size <= itemTarget) continue

    // Persist large items to disk when available — biggest shrink
    // (file body is replaced by a ~2KB preview + path). Falls through
    // to head+tail truncation if no sessionDir OR if the write fails.
    if (item.size > MAX_TOOL_RESULT_LENGTH && sessionDir) {
      const original = item.r.content
      try {
        const dir = join(sessionDir, 'tool-results')
        mkdirSync(dir, { recursive: true })
        const fileName = `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.txt`
        const filePath = join(dir, fileName)
        writeFileSync(filePath, original, 'utf8')
        const preview = original.slice(0, 2000)
        const replacement =
          `${preview}\n\n[... Full output (${original.length} chars) saved to: ${filePath} ...]`
        results[item.i].content = replacement
        currentTotal += replacement.length - original.length
        continue
      } catch {
        // Disk write failed — fall through to in-memory truncation.
      }
    }

    // In-memory head+tail truncation. Shrinks this item to itemTarget
    // so the aggregate fits when every item is processed.
    const original = item.r.content
    if (original.length === 0) continue
    const marker = '\n[output truncated to fit aggregate budget]\n'
    const budget = Math.max(0, itemTarget - marker.length)
    const headLen = Math.floor(budget / 2)
    const tailLen = budget - headLen
    const truncated = itemTarget <= marker.length ? marker.slice(0, itemTarget)
      : original.slice(0, headLen) + marker + (tailLen ? original.slice(-tailLen) : '')
    results[item.i].content = truncated
    currentTotal += truncated.length - original.length
  }
}

const LEGACY_PLAN_MODE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'ExitPlanMode'])
const LEGACY_CONCURRENCY_SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])

// ── Internal types ───────────────────────────────────────────────────────────

interface StreamingToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

interface ParsedToolCall {
  tc: StreamingToolCall
  input: Record<string, unknown>
}

interface ToolBatch {
  safe: boolean
  calls: ParsedToolCall[]
}

// ── Pure helper functions ────────────────────────────────────────────────────

/**
 * Partition tool calls into scheduling batches:
 * - All safe tools → merged into one parallel batch (Promise.all)
 * - Stateful tools (Write, Edit, etc.) → each gets its own serial batch
 *
 * Uses per-input isConcurrencySafe(input) when available (Claude Code pattern),
 * falls back to static CONCURRENCY_SAFE_TOOLS set.
 */
function partitionToolCalls(calls: ParsedToolCall[], tools?: Tool[]): ToolBatch[] {
  const batches: ToolBatch[] = []

  for (const call of calls) {
    // Per-input check: if the tool implements isConcurrencySafe, use it
    const tool = tools?.find(t => t.name === call.tc.name)
    const declaredSafe = tool?.isConcurrencySafe
      ? tool.isConcurrencySafe(call.input)
      : (tool?.metadata?.concurrencySafe ?? LEGACY_CONCURRENCY_SAFE_TOOLS.has(call.tc.name))
    const safe = declaredSafe && (!tool || tool.metadata?.readOnly === true || tool.name === 'Bash')
    const last = batches[batches.length - 1]

    if (last && last.safe && safe) {
      last.calls.push(call) // extend existing parallel batch
    } else {
      batches.push({ safe, calls: [call] }) // new batch
    }
  }

  return batches
}

// ── Engine class ─────────────────────────────────────────────────────────────

export class ExecutionEngine {
  private client: OpenAI
  private tools: Tool[]
  private config: EngineConfig
  private renderer: Renderer
  /** Abort controller for the current turn — null when idle */
  private currentTurnAbortController: AbortController | null = null
  /** Soft-interrupt flag: pause after current tool finishes */
  private softAbortRequested = false
  /**
   * Owner of the soft-abort request — the controller that was current at the
   * moment {@link softAbort} was called. Lets the per-turn `finally` block
   * decide whether the flag belongs to it (safe to clear) or to a sibling
   * turn that started after this one (must be preserved). null means the
   * request was queued while no turn was running; the next turn claims it.
   */
  private softAbortOwner: AbortController | null = null
  /** Event log — may be undefined if not configured */
  private eventLog: EngineConfig['eventLog']
  /** Enabled capability modules */
  private modules: AgentModule[]
  /** Cached boot results (populated in runTurn) */
  private moduleBootResults: ModuleBootResult[] = []
  /** Estimated system prompt tokens — set during boot, used in context budget */
  private systemPromptTokens = 0
  /** All available tools — base + module-provided (populated in runTurn) */
  private allTools: Tool[]
  /** Cost tracker — accumulates real API token usage and USD cost */
  private costTracker: CostTracker
  /** Background task manager — async long-running task lifecycle */
  private backgroundTaskManager: BackgroundTaskManager
  /** Mutable plan-mode flag — can be toggled off by ExitPlanMode tool */
  private planModeActive: boolean
  /** File history — backs up files before edits for undo/checkpoint */
  private fileHistory: FileHistory | null
  /** Unified permission manager — checked before every tool execution */
  private permissionManager: PermissionManager
  /** Whether the endpoint supports stream_options.include_usage (most do) */
  private _streamUsageSupported = true
  /** Consecutive compact failure counter — stops retrying after 3 */
  private _consecutiveCompactFailures = 0
  /** Suppress compact warning after successful compaction (next turn only) */
  private _suppressCompactWarning = false
  /**
   * Reentrancy guard for `runTurn`. Every ExecutionEngine is single-turn
   * per instance: the legacy design reused a singleton slot
   * (`currentTurnAbortController`) for the in-flight turn, which allowed
   * two `runTurn` calls to overlap and share mutable state — aborted siblings
   * would clobber each other's controllers, systemPromptTokens, the message
   * accumulator, cost-tracker entries, etc. The fix is structural: a
   * concurrent `runTurn` call observes this flag and rejects with a clear
   * error BEFORE any side effects fire. This is the "explicitly reject"
   * branch of priority-1.
   */
  private _turnInFlight = false
  private activeRun: RunContext | null = null
  private disposal: Promise<void> | null = null
  private disposed = false
  /**
   * Wall-clock timestamp (epoch ms) of the most recent assistant message
   * the engine has seen. Used by {@link maybeTimeBasedMicroCompact} to
   * decide when the prompt cache has gone cold — after the cache TTL,
   * clearing old tool results is "free" because the next LLM call would
   * reprocess the full prefix anyway. Updated in the `llm_call` state
   * after the streamed response is parsed into an assistant message.
   */
  private lastAssistantTs: number | undefined = undefined
  /**
   * Queued "keep_recent" count for manual context pruning. Set by the
   * `/snip [N]` slash command via {@link queueSnip}; consumed at the
   * start of the next `runTurn`. `null` when nothing is queued.
   *
   * Zero-LLM-cost alternative to `microCompact`/`maybeCompact`: just drops
   * old messages and inserts a boundary marker. Useful when the user
   * wants an instant context reduction.
   */
  private pendingSnipCount: number | null = null

  private getModelContextWindow(): number {
    return resolveContextWindow(this.config.model, this.config.maxContextTokens)
  }

  /**
   * Single source of truth for the `max_tokens` value sent on every
   * completion request (primary, no-stream-options fallback, post-compact
   * retry). Goes through `clampMaxOutputTokens` so small-window models can
   * never silently request more output than the window allows.
   */
  private getEffectiveMaxOutputTokens(): number {
    return clampMaxOutputTokens(this.config.maxOutputTokens, this.getModelContextWindow())
  }

  constructor(config: EngineConfig, renderer: Renderer, client?: OpenAI) {
    assertExecutionProfile(config.executionProfile)
    // Merge agent config into effective config (overrides legacy fields)
    this.config = applyAgentToConfig({
      ...config,
      extraTools: config.extraTools ? [...config.extraTools] : undefined,
      enabledModules: config.enabledModules ? [...config.enabledModules] : undefined,
      verificationExcludedPaths: config.verificationExcludedPaths ? [...config.verificationExcludedPaths] : undefined,
      poor: config.poor ? { ...config.poor } : undefined,
      mcp: config.mcp ? { servers: structuredClone(config.mcp.servers) } : undefined,
      agent: config.agent ? { ...config.agent, identity: { ...config.agent.identity }, tools: config.agent.tools ? [...config.agent.tools] : undefined, disallowedTools: config.agent.disallowedTools ? [...config.agent.disallowedTools] : undefined, modules: config.agent.modules ? structuredClone(config.agent.modules) : undefined } : undefined,
    })
    config = this.config
    this.renderer = renderer
    this.client = client ?? new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      maxRetries: 0,      // SDK auto-retries 429/5xx with exponential backoff
      timeout: 120_000,   // 2 min — covers slow reasoning models (deepseek-reasoner)
    })
    this.client = createModelGateway(this.client, this.config, () => this.activeRun)
    // Wire the engine's private AgentTool only when an agentFactory is
    // available. With no factory, the AgentTool is constructed without
    // wiring and returns "not initialized" at action time — callers can
    // still build engines that legitimately do not spawn sub-agents.
    this.tools = config.agentFactory
      ? createTools(config.extraTools ?? [], {
          // Give THIS engine's AgentTool a private binding to its own
          // factory + config + renderer. The factory closure keeps
          // concurrency isolated; see src/tools/agent.ts for the rationale.
          factory: config.agentFactory,
          parentConfig: config,
          parentRenderer: renderer,
        })
      : createTools(config.extraTools ?? [])
    this.allTools = this.tools  // will be updated with module tools in runTurn
    this.eventLog = config.eventLog
    this.costTracker = new CostTracker()
    this.backgroundTaskManager = new BackgroundTaskManager()
    this.planModeActive = config.planMode ?? false
    this.fileHistory = config.sessionDir ? new FileHistory(config.sessionDir) : null
    this.permissionManager = config.permissionManager ?? new PermissionManager()
    if (!config.permissionManager) {
      if (config.permissionMode === 'auto') this.permissionManager.setMode('bypassPermissions')
      else if (config.permissionMode === 'deny') this.permissionManager.setMode('plan')
      else this.permissionManager.setMode('default')
    }

    // Resolve enabled modules
    const enabledNames = this.deriveEnabledModules()
    this.modules = enabledNames.length > 0
      ? globalModuleRegistry.resolve(enabledNames, {
          client: this.client,
          model: config.model,
          config,
        })
      : []
  }

  /**
   * Determine which modules to enable.
   * If config.enabledModules is explicitly set, use it.
   * Otherwise auto-derive from available config (backward compat).
   */
  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
    // Auto-derive for backward compatibility
    const auto: string[] = []
    if (this.config.semanticMemory && this.config.episodicMemory) {
      auto.push('memory')
    }
    if (this.config.sessionDir && !this.planModeActive) {
      auto.push('critic')
    }
    if (this.config.sessionDir) {
      auto.push('workspace')
    }
    return auto
  }

  /** Hard cancel — immediately aborts in-flight API calls and tool executions */
  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }

  /**
   * Tear down engine-owned side effects. Currently delegates to the
   * BackgroundTaskManager so any long-running tasks spawned during the
   * engine's lifetime (e.g. via the Bash tool's `run_in_background:true`)
   * do not outlive the engine. Required by AgentTool so child engines —
   * which have their own BackgroundTaskManager distinct from the parent's —
   * are disposed when the sub-agent completes, aborts, or errors.
   *
   * Also calls dispose() on each module that implements it (e.g. McpModule
   * closes its stdio server processes). Modules that don't expose dispose()
   * are skipped — this method is opt-in per module.
   *
   * Safe to call multiple times (the underlying manager's dispose is
   * idempotent). Safe to call before any turn has run (no-op on an
   * empty task map). Never throws.
   */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.abort()
    this.disposal = (async () => {
      const failures: string[] = []
      const resources: Array<[string, () => void | Promise<void>]> = [
        ...[...(this.activeRun?.pending.entries() ?? [])].map(([name, pending]) => [name, () => pending.then(() => {}, () => {})] as [string, () => Promise<void>]),
        ['background', () => this.backgroundTaskManager.dispose()],
        ...this.modules.map(module => [module.name, () => module.dispose?.()] as [string, () => void | Promise<void>]),
      ]
      for (const [name, cleanup] of resources) {
        const pending = Promise.resolve().then(cleanup)
        try { await settleWithin(pending, this.config.cancellationGraceMs ?? 2000) }
        catch {
          quarantineWorkspace(this.config.cwd, pending)
          failures.push(name)
          this.renderer.warn('Resource cleanup incomplete: ' + name)
        }
      }
      if (failures.length) throw new Error('Resource cleanup incomplete: ' + failures.join(', '))
    })()
    return this.disposal
  }

  /** Soft interrupt — pause after current tool, preserve history */
  softAbort(): void {
    this.softAbortRequested = true
    // Owner = the controller of whichever turn was current at the time of
    // the request. If no turn is running, owner is null and the next turn
    // claims the request on its first check_abort.
    this.softAbortOwner = this.currentTurnAbortController
  }

  /**
   * Attempt to claim a pending soft-abort request for the supplied turn
   * controller. Returns true iff the flag was set AND its owner is either
   * null (queued while idle) or matches our controller. On success, the
   * flag and owner are cleared so subsequent turns see a clean slate.
   */
  private claimSoftAbort(turnAbortController: AbortController): boolean {
    if (!this.softAbortRequested) return false
    if (this.softAbortOwner !== null && this.softAbortOwner !== turnAbortController) {
      return false
    }
    this.softAbortRequested = false
    this.softAbortOwner = null
    return true
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    const sections = moduleSections.length > 0
      ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
      : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }

  // ── Tool definitions ────────────────────────────────────────────────────

  private getToolDefinitions(planMode: boolean, moduleTools: Tool[] = []): ToolDefinition[] {
    // Merge base tools + module-provided tools
    const allTools = [...this.tools, ...moduleTools]
    let defs = getToolDefinitions(allTools)
    // Filter by agent tool list when a sub-agent config is in play.
    //
    // Two shapes of filtering here:
    //   1. Sub-agent (config.agent set): delegate to filterToolsForSubAgent
    //      so the global denylist (Agent, EnterPlanMode, …) is enforced in
    //      addition to the per-agent allow/deny lists.
    //   2. Main thread with an explicit `agent.tools` (rare — agent.tools on
    //      the main thread is an unusual override path) — just apply the
    //      allowlist, no global denylist.
    if (this.config.agent) {
      const allNames = defs.map(t => t.function.name)
      const filtered = (this.config.initialAgentDepth ?? 0) > 0
        ? filterToolsForSubAgent(allNames, this.config.agent.tools, this.config.agent.disallowedTools)
        : allNames.filter(name => (!this.config.agent?.tools || this.config.agent.tools.includes(name)) && !this.config.agent?.disallowedTools?.includes(name))
      const allowedSet = new Set(filtered)
      defs = defs.filter(t => allowedSet.has(t.function.name))
    }
    // Filter by plan mode (read-only tools only)
    if (planMode) {
      defs = defs.filter((t) => {
        const tool = allTools.find(candidate => candidate.name === t.function.name)
        return tool?.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(t.function.name)
      })
    }
    return defs
  }

  // ── Context budget ──────────────────────────────────────────────────────

  private async evaluateContextBudget(
    messages: OpenAIMessage[],
    toolDefs?: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal?: AbortSignal,
  ): Promise<void> {
    // Snapshot and reset the compact-warning suppression flag atomically.
    // The previous implementation cleared this flag at the start of EVERY
    // budget check, which meant the flag — set by a successful compact
    // earlier in the same call — was never read in a meaningful state
    // and the "next turn only" semantics described in the field's
    // declaration never fired.
    //
    // Lifecycle now:
    //   1. read + reset: snapshot into a local, reset the instance flag
    //   2. emit warning if `shouldWarn && !suppressed` — uses the snapshot,
    //      so a previous turn's compact suppresses THIS call's warning
    //   3. on a fresh compact in step 4, set the flag again for the
    //      NEXT call to read
    const suppressCompactWarning = this._suppressCompactWarning
    this._suppressCompactWarning = false

    // Resolve the actual context window for the model. Use the cached getter
    // so we don't recompute the lookup on every iteration.
    const maxCtxTokens = this.getModelContextWindow()
    // Count messages + system prompt + tool-definition cost.
    // Without the tools term we systematically underestimated by
    // ~50–200 tokens per tool — a real budget pressure on a 20-tool setup.
    const messageTokens = estimateTokens(messages)
    const toolDefTokens = estimateToolDefinitionTokens(toolDefs)
    const totalTokens = messageTokens + this.systemPromptTokens + toolDefTokens
    // Reserve room for the model's own output. Using the FULL window as the
    // budget denominator would let warnings fire at thresholds that
    // mathematically guarantee an API rejection on small-window models
    // (e.g. 8k window + 8k default max → firing at 70% of 8k = 5.6k input
    // would still leave 2.4k of free space, but the model would attempt
    // 8k output and OVERFLOW). Using `window - reservedOutput` aligns the
    // percentage with what the model can actually accept.
    const inputBudget = effectiveInputBudget(maxCtxTokens, this.config.maxOutputTokens)
    const pct = totalTokens / inputBudget
    // Pull the pressure thresholds from the compact module so we have ONE
    // source of truth — the previous inline 0.50/0.70/0.85 numeric copies
    // could drift from CONTEXT_*_PCT in compact.ts.
    const shouldMicroCompact = pct >= CONTEXT_MICROCOMPACT_PCT
    const shouldWarn = pct >= CONTEXT_WARN_PCT
    const shouldCompact = pct >= CONTEXT_COMPACT_PCT
    const strategy = getCompressionStrategy(pct)

    // ── Time-based microCompact: when the session has been idle past the
    // prompt-cache TTL, the next LLM call will re-process the full
    // prefix anyway — clearing old tool results NOW is "free" (no cache
    // hit to forfeit). Uses the engine's tracked `lastAssistantTs` so
    // the gate is wall-clock-based rather than a message-count proxy.
    if (!shouldCompact) {
      const tbResult = maybeTimeBasedMicroCompact(messages, this.lastAssistantTs)
      if (tbResult.compacted) {
        this.eventLog?.append('context_compact', 'engine', {
          type: 'time_based_microcompact',
          tokens_before: tbResult.tokensBefore,
          tokens_after: tbResult.tokensAfter,
          tools_cleared: tbResult.toolsCleared,
        })
      }
    }

    // ── Pressure-based microCompact: clear old tool results at 50% pressure ──
    // Clear old tool results at 50% pressure, before resorting to full
    // LLM-summarization compact at 85%.
    if (shouldMicroCompact && !shouldCompact) {
      const mcResult = microCompact(messages)
      if (mcResult.compacted) {
        this.eventLog?.append('context_compact', 'engine', {
          type: 'microcompact',
          tokens_before: mcResult.tokensBefore,
          tokens_after: mcResult.tokensAfter,
          tools_cleared: mcResult.toolsCleared,
        })
      }
    }

    if (this.config.sessionDir && shouldWarn && !suppressCompactWarning) {
      this.renderer.contextWarning(totalTokens, maxCtxTokens, pct)
    }

    if (shouldCompact && this._consecutiveCompactFailures < 3) {
      this.renderer.compactStart(totalTokens)
      this.eventLog?.append('context_compact', 'engine', {
        strategy,
        tokens_before: totalTokens,
        system_prompt_tokens: this.systemPromptTokens,
        pct,
      })

      const compactResult = await maybeCompact(
        this.client,
        this.config.model,
        messages,
        turnAbortSignal,
      )

      if (compactResult.compacted) {
        messages.length = 0
        messages.push(...compactResult.messages)
        this.renderer.compactDone(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
        this.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        this._consecutiveCompactFailures = 0  // reset on success
        this._suppressCompactWarning = true   // suppress warning next turn
        // Lifecycle hook: OnContextOverflow
        this.config.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      } else {
        // Compaction failed — increment circuit breaker
        this._consecutiveCompactFailures++
        if (this._consecutiveCompactFailures >= 3) {
          this.renderer.warn(
            `Auto-compact failed ${this._consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
      }
    }
  }

  // ── LLM call ────────────────────────────────────────────────────────────

  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    this.renderer.startSpinner()

    const callStartMs = Date.now()

    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
          temperature: this.config.temperature ?? 0,
          max_tokens: this.getEffectiveMaxOutputTokens(),
          stream: true,
          ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: turnAbortSignal },
      )
    } catch (err: unknown) {
      this.renderer.stopSpinner()

      const errMsg = (err as Error).message || ''

      // Fallback: some endpoints reject stream_options with 400 — retry without it
      if (errMsg.includes('stream_options') || errMsg.includes('stream_options is not supported')) {
        this._streamUsageSupported = false
        stream = await this.client.chat.completions.create(
          {
            model: this.config.model,
            messages: [
              { role: 'system', content: systemPrompt },
              ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
            ],
            tools: toolDefs,
            tool_choice: 'auto',
            temperature: this.config.temperature ?? 0,
            max_tokens: this.getEffectiveMaxOutputTokens(),
            stream: true,
          },
          { signal: turnAbortSignal },
        )
        const result = await this.consumeStream(stream, turnAbortSignal)
        this.recordUsage(result.usage, callStartMs)
        return result
      }

      // Reactive compact: if API rejected due to context length, auto-compact and retry once.
      //
      // Match logic:
      //   - `context_length_exceeded` (OpenAI) — explicit code
      //   - `maximum context length` (Anthropic / generic) — explicit phrase
      //   - bare `too long` is NOT included — too many user-facing error
      //     strings contain "too long" without referring to context
      //     (e.g. "request body was too long"). For `too long` to count,
      //     a nearby context-token synonym must appear in a 80-char
      //     window: this limits false positives to messages that actually
      //     describe a context overflow.
      const compactErrMsg = (err as Error).message || ''
      const isContextOverflowError =
        compactErrMsg.includes('context_length_exceeded') ||
        compactErrMsg.includes('maximum context length') ||
        /context[\s_-]{0,80}(?:is\s+)?too\s+long/i.test(compactErrMsg) ||
        /too\s+long[\s_-]{0,80}(?:context|tokens?|input|window|limit)/i.test(compactErrMsg)
      if (isContextOverflowError) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compactResult = await maybeCompact(this.client, this.config.model, messages, turnAbortSignal)
        if (compactResult.compacted) {
          messages.length = 0
          messages.push(...compactResult.messages)
          this.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
          // Retry the call with compacted messages
          stream = await this.client.chat.completions.create(
            {
              model: this.config.model,
              messages: [
                { role: 'system', content: systemPrompt },
                ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
              ],
              tools: toolDefs.length > 0 ? toolDefs : undefined,
              tool_choice: toolDefs.length > 0 ? 'auto' : undefined,
              temperature: this.config.temperature ?? 0,
          max_tokens: this.getEffectiveMaxOutputTokens(),  // post-compact retry uses same default as primary path
              stream: true,
              ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
            },
            { signal: turnAbortSignal },
          )
          const result = await this.consumeStream(stream, turnAbortSignal)
          this.recordUsage(result.usage, callStartMs)
          return result
        }
      }
      throw err
    }

    const result = await this.consumeStream(stream, turnAbortSignal)
    this.recordUsage(result.usage, callStartMs)
    return result
  }

  /** Feed API usage into the cost tracker (if present) */
  private recordUsage(usage: TokenUsage | null, callStartMs: number): void {
    if (usage) {
      const durationMs = Date.now() - callStartMs
      this.costTracker.addUsage(this.config.model, usage, durationMs)
      this.eventLog?.append('tool_call', 'llm_api', {
        input_tokens: usage.inputTokens,
        output_tokens: usage.outputTokens,
        duration_ms: durationMs,
      })
    }
  }

  /** Consume the streaming response, accumulating text and tool calls */
  private async consumeStream(
    stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
    turnAbortSignal: AbortSignal,
  ): Promise<{
    assistantText: string
    finishReason: string | null
    rawToolCalls: StreamingToolCall[]
    usage: TokenUsage | null
  }> {
    let assistantText = ''
    let finishReason: string | null = null
    let usage: TokenUsage | null = null
    const toolCallsMap = new Map<number, StreamingToolCall>()
    const thinkingTagFilter = new ThinkingTagFilter()
    let firstToken = true

    // Stream-level timeout — if no chunk arrives for 120s, abort (prevents API hang)
    const STREAM_TIMEOUT_MS = 120_000
    let lastChunkTime = Date.now()
    const turnController = this.currentTurnAbortController

    // Watchdog: checks every 10s if stream has stalled
    const watchdog = setInterval(() => {
      if (Date.now() - lastChunkTime > STREAM_TIMEOUT_MS) {
        // Force-abort the AbortController (not just dispatch event)
        if (turnController) {
          turnController.abort('stream_timeout')
        }
      }
    }, 10_000)
    const stopWatchdog = (): void => clearInterval(watchdog)
    turnAbortSignal.addEventListener('abort', stopWatchdog, { once: true })

    try {
      for await (const chunk of stream) {
        if (turnAbortSignal.aborted) break

        lastChunkTime = Date.now()  // reset watchdog on each chunk

        // Capture usage from the final chunk (stream_options.include_usage)
        // The usage chunk often has an empty choices array, so check before delta.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
          }
        }

        const delta = chunk.choices[0]?.delta
        if (!delta) continue

        if (delta.content) {
          const visibleContent = thinkingTagFilter.push(delta.content)
          // Route reasoning content to renderer (if supported)
          const thinkingContent = thinkingTagFilter.drainThinking()
          if (thinkingContent) {
            this.renderer.streamReasoning?.(thinkingContent)
          }
          if (visibleContent) {
            if (firstToken) {
              this.renderer.stopSpinner()
              this.renderer.beginAssistantText()
              firstToken = false
            }
            this.renderer.streamToken(visibleContent)
            assistantText += visibleContent
          }
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index
            if (!toolCallsMap.has(idx)) {
              toolCallsMap.set(idx, {
                index: idx,
                id: '',
                name: '',
                arguments: '',
              })
            }
            const acc = toolCallsMap.get(idx)!
            if (tc.id) acc.id = tc.id
            if (tc.function?.name) acc.name += tc.function.name
            if (tc.function?.arguments) acc.arguments += tc.function.arguments
          }
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason
        }
      }

      turnAbortSignal.throwIfAborted()
      const trailingContent = thinkingTagFilter.finish()
      const trailingThinking = thinkingTagFilter.drainThinking()
      if (trailingThinking) {
        this.renderer.streamReasoning?.(trailingThinking)
      }
      if (trailingContent) {
        if (firstToken) {
          this.renderer.stopSpinner()
          this.renderer.beginAssistantText()
          firstToken = false
        }
        this.renderer.streamToken(trailingContent)
        assistantText += trailingContent
      }
    } catch (err: unknown) {
      if (!turnAbortSignal.aborted) this.renderer.stopSpinner()
      throw err
    } finally {
      stopWatchdog()
      turnAbortSignal.removeEventListener('abort', stopWatchdog)
    }

    clearInterval(watchdog)
    this.renderer.stopSpinner()

    // Stream-timeout watchdog: if the stream was aborted due to stall,
    // throw so the engine's error path fires (instead of looking like
    // success). The watchdog sets the abort reason to 'stream_timeout'
    // (see the setInterval above) — we MUST gate on that reason so that
    // engine.abort() (reason='user_cancelled') does NOT get misreported
    // as a stream timeout. Without this gate, any user-initiated cancel
    // during an active stream would surface as a "Stream timed out —
    // no data received for 120s" error in the renderer, which is wrong
    // (the user cancelled, the stream didn't stall) and confusing.
    if (
      turnAbortSignal.aborted &&
      !finishReason &&
      turnAbortSignal.reason === 'stream_timeout'
    ) {
      throw new Error('Stream timed out — no data received for 120s')
    }

    if (assistantText) {
      this.renderer.endAssistantText()
    }

    const rawToolCalls = Array.from(toolCallsMap.values()).sort(
      (a, b) => a.index - b.index,
    ).map((tc) => {
      // Some providers (vLLM, LM Studio, Ollama) omit tool_call id;
      // synthesize one to prevent "tool_call_id does not match" on next turn
      if (!tc.id) {
        tc.id = `call_${randomUUID()}`
      }
      return tc
    })

    return { assistantText, finishReason, rawToolCalls, usage }
  }

  // ── Tool execution ──────────────────────────────────────────────────────

  private async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    planMode: boolean,
    turnNumber: number,
  ): Promise<ToolResult> {
    const tool = findTool(this.allTools, toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }

    // In plan mode, block write tools (defence in depth)
    if (this.isPlanMode() && !(tool.metadata?.readOnly === true || LEGACY_PLAN_MODE_TOOLS.has(toolName))) {
      return {
        content: `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`,
        isError: true,
      }
    }

    // Enforce agent tool list (defence in depth — LLM shouldn't see tools
    // it hasn't been granted, AND we re-check the global sub-agent
    // denylist at call time so a model that guesses a tool name can't
    // reach it via a parallel call that slipped past `getToolDefinitions`).
    // The locals below sidestep a TS narrowing quirk where `else if
    // (this.config.agent?.tools)` collapses to `never` after the outer
    // `if (this.config.agent)` narrows the property to non-undefined.
    const agent = this.config.agent
    const agentToolsFallback = agent?.tools
    if (agent) {
      const allNames = this.allTools.map(t => t.name)
      const filtered = (this.config.initialAgentDepth ?? 0) > 0
        ? filterToolsForSubAgent(allNames, agent.tools, agent.disallowedTools)
        : allNames.filter(name => (!agent.tools || agent.tools.includes(name)) && !agent.disallowedTools?.includes(name))
      if (!filtered.includes(toolName)) {
        return {
          content: `Tool "${toolName}" is not available to this agent.`,
          isError: true,
        }
      }
    } else if (agentToolsFallback && !agentToolsFallback.includes(toolName)) {
      return {
        content: `Tool "${toolName}" is not available to this agent.`,
        isError: true,
      }
    }

    const isDangerous = (toolName === 'ExitWorktree' && input.action === 'discard') ||
      (toolName === 'Bash' && typeof input.command === 'string'
        ? classifyCommandRisk(input.command) === 'dangerous'
        : false)
    const managerPermission = this.permissionManager.check(toolName, input, isDangerous)
    const permission = managerPermission === 'deny' ? 'deny'
      : this.config.permissionMode === 'deny' && tool.metadata?.readOnly !== true ? 'deny'
      : this.config.permissionMode === 'ask' && tool.metadata?.readOnly !== true && this.permissionManager.getMode() === 'default' && checkRules(this.permissionManager.getRules(), toolName, input)?.behavior !== 'allow' ? 'ask'
      : managerPermission
    if (permission === 'deny') {
      return {
        content: `Permission denied for ${toolName}. Current mode: ${this.permissionManager.formatMode()}`,
        isError: true,
      }
    }
    let permissionApproved = permission === 'allow'
    if (permission === 'ask') {
      if (this.config.requestPermission) {
        const riskLevel = isDangerous ? 'dangerous' : 'needs-approval'
        const permResult = await this.config.requestPermission(toolName, input, riskLevel)
        context.signal?.throwIfAborted()
        permissionApproved = permResult.approved
        if (!permResult.approved) {
          const feedback = permResult.feedback?.trim()
          return {
            content: feedback
              ? `Permission denied by user for ${toolName}. Feedback: ${feedback}`
              : `Permission denied by user for ${toolName}.`,
            isError: true,
          }
        }
      } else {
        return { content: `Approval required for ${toolName}; no approval channel is available.`, isError: true, status: 'needs_input' }
      }
    }

    context.signal?.throwIfAborted()
    const run = this.activeRun
    const operationId = run?.store?.intent(toolName, tool.metadata?.readOnly === true)
    const processScope = createProcessScope(this.config.executionProfile)
    const result = await processScope.run(() => tool.execute(input, { ...context, permissionApproved }))
    if (operationId && run?.store) {
      if (processScope.pending.size) {
        const receipt = Promise.all([...processScope.pending]).then(() => run.store!.receipt(operationId, result.isError ? 'failed' : 'completed'))
        run.pending.set('physical:' + operationId, receipt)
        void receipt.then(() => run.pending.delete('physical:' + operationId), () => run.controller.abort('RunStore receipt persistence failed'))
      } else run.store.receipt(operationId, result.isError ? 'failed' : 'completed')
    }
    if (!result.isError && ['Write', 'Edit', 'NotebookEdit'].includes(toolName) && this.activeRun) this.activeRun.mutationAttempted = true
    if (context.signal?.aborted) return { ...result, isError: true, status: 'cancelled', content: 'Cancelled after physical tool completion: ' + result.content }

    // Notify modules of tool execution (e.g. episodic memory write)
    for (const module of this.modules) {
      await module.onToolCall?.(toolName, input, result, turnNumber)
    }

    return result
  }

  // ── Tool scheduling ─────────────────────────────────────────────────────

  /**
   * Schedule tool calls: parallel batches for safe tools, serial for
   * state-mutating ones. Returns true if a soft abort was requested
   * during execution.
   */
  private async scheduleToolCalls(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    planMode: boolean,
    turnAbortController: AbortController,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{ aborted: boolean }> {
    const run = this.activeRun!
    const signal = turnAbortController.signal
    const batches = partitionToolCalls(parsedCalls, this.allTools)
    const limit = Math.max(1, Math.min(16, Math.floor(this.config.maxToolConcurrency ?? 4)))
    const settled = new Set<string>()
    let interrupted = false
    const publish = (call: ParsedToolCall, result: ToolResult): void => {
      if (settled.has(call.tc.id)) return
      settled.add(call.tc.id)
      const { tc } = call
      const failureKey = tc.name === 'Agent' ? tc.id : tc.name + ':' + JSON.stringify(call.input)
      if (result.isError) run.toolFailures.set(failureKey, result)
      else run.toolFailures.delete(failureKey)
      this.config.hookRunner?.runPostToolCall(tc.name, result.content, result.isError)
      this.renderer.toolResult(tc.name, result.content, result.isError)
      this.eventLog?.append('tool_result', tc.name, { content: result.content.slice(0, 500), isError: result.isError, status: result.status, run_id: run.runId })
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content: truncateToolResult(result.content.trim() || '(' + tc.name + ' returned no output)', this.config.sessionDir) })
    }
    const execute = async (call: ParsedToolCall): Promise<ToolResult> => {
      const { tc, input } = call
      if (signal.aborted) return { content: 'Cancelled before execution', isError: true, status: 'cancelled' }
      try {
        this.renderer.toolStart(tc.name, input)
        this.config.hookRunner?.runPreToolCall(tc.name, input)
        this.eventLog?.append('tool_call', tc.name, { input, run_id: run.runId })
        const tool = findTool(this.allTools, tc.name)
        const readOnly = tool?.metadata?.readOnly === true || (tc.name === 'Bash' && tool?.isConcurrencySafe?.(input) === true)
        return await runOperation(run, 'tool:' + tc.name, () => withWorkspaceAccess(
          toolContext.cwd, run.familyId, !readOnly, signal,
          () => this.executeToolCall(tc.name, input, toolContext, this.isPlanMode(), turnNumber),
        ), this.config.toolTimeoutMs ?? 1_800_000, this.config.cancellationGraceMs ?? 2000)
      } catch (error) {
        return { content: (error as Error).message ?? String(error), isError: true, status: signal.aborted ? 'cancelled' : (error as Error).name === 'WorkspaceUnavailableError' ? 'blocked' : 'failed' }
      }
    }
    try {
      for (const batch of batches) {
        for (let offset = 0; offset < batch.calls.length; offset += limit) {
          if (signal.aborted || interrupted) break
          const calls = batch.calls.slice(offset, offset + limit)
          const results = await Promise.all(calls.map(execute))
          const budgeted = results.map((result, index) => ({ content: result.content, tc: calls[index].tc }))
          enforceAggregateToolResultBudget(budgeted, this.config.sessionDir)
          calls.forEach((call, index) => publish(call, { ...results[index], content: budgeted[index].content }))
          if (this.claimSoftAbort(turnAbortController)) interrupted = true
          if (results.some(result => result.status === 'needs_input')) interrupted = true
        }
        if (signal.aborted || interrupted) break
      }
    } finally {
      for (const call of parsedCalls) {
        if (!settled.has(call.tc.id)) publish(call, { content: 'Cancelled before execution; no side effects started', isError: true, status: 'cancelled' })
      }
    }
    return { aborted: signal.aborted || interrupted }
  }

  // ── Build tool context ──────────────────────────────────────────────────

  private buildToolContext(
    turnAbortSignal: AbortSignal,
    modulePatches: Partial<ToolContext> = {},
  ): ToolContext {
    return {
      cwd: this.config.cwd,
      executionProfile: this.config.executionProfile,
      permissionMode: this.config.permissionMode,
      permissionManager: this.permissionManager,
      requestPermission: this.config.requestPermission,
      runId: this.activeRun?.runId,
      parentRunId: this.activeRun?.parentRunId,
      workspaceBound: (this.config.initialAgentDepth ?? 0) > 0,
      runFamilyId: this.activeRun?.familyId,
      fileState: this.activeRun?.fileState,
      workspace: this.activeRun?.workspace,
      verificationExcludedPaths: [...(this.config.verificationExcludedPaths ?? []), ...(this.config.sessionDir ? [this.config.sessionDir] : [])],
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      eventLog: this.eventLog,
      backgroundTaskManager: this.backgroundTaskManager,
      askUserQuestion: this.config.askUserQuestion,
      exitPlanMode: this.config.exitPlanMode ? async (plan: string): Promise<boolean> => {
        const approved = await this.config.exitPlanMode?.(plan) ?? false
        turnAbortSignal.throwIfAborted()
        if (approved) this.exitPlanMode()
        return approved
      } : undefined,
      enterPlanMode: () => { this.enterPlanMode() },
      fileHistory: this.fileHistory ?? undefined,
      // Module patches override/extend the base context (incl. availableToolNames)
      ...modulePatches,
    }
  }

  // ── Main loop ───────────────────────────────────────────────────────────

  /**
   * Execute a single user turn with streaming output.
   *
   * State-machine-driven Think → Act → Observe loop with module lifecycle hooks.
   * The loop drives a pure reducer (transitionQueryState) — each iteration
   * inspects the current state, performs its side effects, and emits the next
   * event. This replaces the legacy inline while-loop with explicit, testable
   * states: boot → check_abort → budget_check → module_iteration → llm_call →
   * continuation_check → parse_response → tool_execution → check_abort …
   */
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{ path: string; dataUrl: string }>,
  ): Promise<{ result: TurnResult; newHistory: OpenAIMessage[] }> {
    // ── Reentrancy guard ──────────────────────────────────────────────────
    // The engine is single-turn per instance: every mutable field
    // (currentTurnAbortController, systemPromptTokens, moduleBootResults,
    // costTracker, the messages accumulator, _consecutiveCompactFailures,
    // etc.) is shared. Two overlapping runTurn calls would silently
    // overwrite each other's state — a sibling's `finally` could null
    // the controller of the turn currently in flight. Reject the second
    // call up front so callers can't accidentally race.
    //
    // Resolution paths:
    //   1. Concurrent call → reject with a clear error before any work
    //   2. For nested sub-agents, build a NEW ExecutionEngine per spawn
    //      (AgentTool's factory pattern — already the supported path)
    //   3. For "queue the next prompt", await the current turn and call
    //      runTurn again — the flag clears in the `finally`.
    if (this._turnInFlight) {
      throw new Error(
        'ExecutionEngine.runTurn rejected: another turn is already in progress on this engine instance. ' +
        'Each ExecutionEngine is single-turn; await the in-flight turn or spawn a new engine via EngineConfig.agentFactory.',
      )
    }
    if (this.disposed) throw new Error('ExecutionEngine is disposed')
    if (isWorkspaceQuarantined(this.config.cwd)) {
      return { result: { stopped: true, reason: 'error', status: 'blocked', output: 'Workspace has unfinished operations from a previous run; wait for resource settlement.', verification: { status: 'not_run', workspace: this.config.cwd, commands: [], output: 'Workspace quarantined' } }, newHistory: history }
    }
    this._turnInFlight = true
    const run = createRunContext(this.config)
    this.activeRun = run
    const turnAbortController = run.controller
    this.currentTurnAbortController = turnAbortController

    // Every line of code below runs inside an OUTER try/finally whose
    // sole job is releasing `_turnInFlight`. Critical: any throw between
    // here and the existing inner try would previously have leaked the
    // flag and permanently locked the engine. Setup steps that can
    // throw include:
    //   - clearFileState() (filesystem)
    //   - module boot (each module's `boot()` is a third-party hook)
    //   - buildSystemPrompt() (pure but allocates heavily)
    //   - buildToolContext() (renders initial tool context)
    // The outer finally is the single, unconditional release point —
    // success, soft-abort, hard-abort, and ANY thrown error all flow
    // through it, so the engine can never get stuck.
    let result: TurnResult
    let messages: OpenAIMessage[] = [...settleHistory(history), { role: 'user', content: userMessage }]
    try {
      initializeRunStore(run)
      const planMode = this.isPlanMode()

      // Clear file read state for this turn (read-before-edit is per-turn, not cross-turn)
      const verificationPlan = createVerificationPlan(this.config.cwd, undefined, [...(this.config.verificationExcludedPaths ?? []), ...(this.config.sessionDir ? [this.config.sessionDir] : [])])
      const startingArtifact = await runOperation(run, 'artifact:snapshot', () => captureArtifactVersion(this.config.cwd, verificationPlan.excludedPaths, { signal: run.controller.signal }), 60_000, this.config.cancellationGraceMs ?? 2000)
      run.store?.acceptance(verificationPlan.definitionHash, startingArtifact)

      // ── Boot Sequence: resolve + boot modules ──
      const bootCtx: ModuleBootContext = {
        cwd: this.config.cwd,
        sessionDir: this.config.sessionDir,
        config: this.config,
        userMessage,
        abortSignal: turnAbortController.signal,
        model: this.config.model,
      }
      this.moduleBootResults = []
      for (const module of this.modules) {
        this.moduleBootResults.push(await runOperation(run, 'boot:' + module.name, () => Promise.resolve(module.boot(bootCtx)), 60_000, this.config.cancellationGraceMs ?? 2000))
      }
      const moduleSections = this.moduleBootResults.flatMap(r => r.systemPromptSections ?? [])
      const toolContextPatch = this.moduleBootResults.reduce(
        (acc, r) => ({ ...acc, ...r.toolContextPatch }),
        {} as Partial<ToolContext>,
      )
      // Collect tools provided by modules
      const moduleTools = this.moduleBootResults.flatMap(r => r.tools ?? [])
      this.allTools = [...this.tools, ...moduleTools]

      // Record boot trajectory (AgentOS pattern)
      this.eventLog?.append('boot_context', 'engine', {
        trajectory: 'boot_context',
        modules: this.modules.map(m => m.name),
        module_sections: moduleSections.length,
        module_tools: moduleTools.length,
        user_message_length: userMessage.length,
      })

      // Build system prompt (with module sections) and tool definitions
      let systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
      // Estimate system prompt tokens for accurate context budget
      this.systemPromptTokens = Math.ceil(systemPrompt.length / 3.5) + 20
      let toolDefs = this.getToolDefinitions(planMode, moduleTools)

      // Per-turn AbortController


      // Initialize messages — construct multimodal content if images are provided
      let userContent: string | ContentPart[]
      if (images && images.length > 0) {
        userContent = [
          { type: 'text', text: normalizeCJKInput(userMessage) },
          ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl } })),
        ]
      } else {
        userContent = normalizeCJKInput(userMessage)
      }
      messages = [...settleHistory(history), { role: 'user', content: userContent }]

      // Apply a queued `/snip [N]` first, if any. See `queueSnip`. The
      // boundary marker is inserted into `messages` here so the very
      // first LLM call of this turn sees the truncated history.
      if (this.pendingSnipCount !== null) {
        const queuedKeep = this.pendingSnipCount
        this.pendingSnipCount = null
        this.applySnipToMessages(messages, queuedKeep, 'queued via /snip')
      }

      const toolContext = this.buildToolContext(
        turnAbortController.signal,
        {
          ...toolContextPatch,
          availableToolNames: toolDefs.map(t => t.function.name),
          // `snipMessages` mutates the live `messages` array held by
          // this `runTurn`. Provided here (not via module patch) because
          // it needs closure over the *local* `messages` reference.
          snipMessages: (keepRecent: number, reason?: string) =>
            this.applySnipToMessages(messages, keepRecent, reason),
          // Snapshot accessor for introspection tools (Brief, CtxInspect).
          // Returns a shallow copy so tools can't mutate the live array.
          getMessages: () => messages.map(m => ({ ...m })),
        },
      )

      // ── State machine driver ───────────────────────────────────────────
      let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })

      let finalOutput = ''
      let lastToolName: string | undefined
      // Tool calls pending parse — stashed in llm_call, consumed in parse_response
      let pendingToolCalls: StreamingToolCall[] = []
      // Parsed tool calls — stashed in parse_response, consumed in tool_execution
      let pendingParsedCalls: ParsedToolCall[] = []
      // Continuation budget tracking (opt-in via config.enableContinuation)
      const enableContinuation = this.config.enableContinuation ?? false
      const turnTokenBudget =
        this.config.turnTokenBudget ?? this.getEffectiveMaxOutputTokens() * 4
      const budgetTracker = createBudgetTracker()
      let turnTokensProduced = 0
      let emptyResponseCount = 0
      const MAX_EMPTY_RETRIES = 2
      let lengthRetryCount = 0
      const MAX_LENGTH_RETRIES = 3

    try {
      while (!isTerminal(state)) {
        switch (state.kind) {
          case 'check_abort': {
            if (turnAbortController.signal.aborted) {
              state = transitionQueryState(state, { type: 'hard_abort', output: finalOutput })
            } else if (this.claimSoftAbort(turnAbortController)) {
              state = transitionQueryState(state, { type: 'soft_abort', output: finalOutput })
            } else if (state.iteration > this.config.maxIterations) {
              this.renderer.warn(
                `Max iterations (${this.config.maxIterations}) reached`,
              )
              state = transitionQueryState(state, { type: 'max_iterations', output: finalOutput })
            } else {
              state = transitionQueryState(state, { type: 'continue' })
            }
            break
          }

          case 'budget_check': {
            await this.evaluateContextBudget(messages, toolDefs, turnAbortController.signal)
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'module_iteration': {
            const iteration = state.iteration
            for (const module of this.modules) {
              if (!module.onIteration) continue
              const iterResult = await runOperation(run, 'iteration:' + module.name, () => Promise.resolve(module.onIteration?.({
                iteration,
                messages,
                abortSignal: turnAbortController.signal,
              })), 60_000, this.config.cancellationGraceMs ?? 2000)
              if (iterResult?.injectMessage) {
                const msg = iterResult.injectMessage
                // Show full critic output to user via renderer (not raw stdout)
                const lines = msg.split('\n').filter(l => l.trim())
                for (const line of lines) {
                  this.renderer.warn(`[${module.name}] ${line}`)
                }
                this.eventLog?.append('module_flag', module.name, {
                  message: msg.slice(0, 500),
                  iteration: state.iteration,
                })
                messages.push({ role: 'system', source: 'module', content: msg })
              }
            }
            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'llm_call': {
            turnAbortController.signal.throwIfAborted()
            systemPrompt = this.buildSystemPrompt(this.isPlanMode(), moduleSections)
            this.systemPromptTokens = estimateTokens([{ role: 'system', content: systemPrompt }])
            toolDefs = this.getToolDefinitions(this.isPlanMode(), moduleTools)
            toolContext.availableToolNames = toolDefs.map(def => def.function.name)
            await this.evaluateContextBudget(messages, toolDefs, turnAbortController.signal)
            const { assistantText, finishReason, rawToolCalls } =
              await runOperation(run, 'model:stream', () => this.callLLM(
                systemPrompt,
                messages,
                toolDefs,
                turnAbortController.signal,
              ), 300_000, this.config.cancellationGraceMs ?? 2000)

            if (assistantText) {
              finalOutput += assistantText
              turnTokensProduced += Math.ceil(assistantText.length / 3.5)
            }

            const knownIds = new Set(messages.flatMap(message => message.tool_calls?.map(call => call.id) ?? []))
            for (const call of rawToolCalls) {
              if (knownIds.has(call.id)) call.id = `call_${randomUUID()}`
              knownIds.add(call.id)
            }

            // Build assistant message
            const assistantMsg: OpenAIMessage = {
              role: 'assistant',
              content: assistantText || null,
              tool_calls:
                rawToolCalls.length > 0
                  ? rawToolCalls.map((tc) => ({
                      id: tc.id,
                      type: 'function' as const,
                      function: { name: tc.name, arguments: tc.arguments },
                    }))
                  : undefined,
            }
            messages.push(assistantMsg)

            // Stamp the wall-clock time of THIS assistant message so the
            // next evaluateContextBudget pass can decide whether the prompt
            // cache has gone cold. Recorded AFTER the message is pushed
            // because the time-based compact gate uses this as its baseline.
            this.lastAssistantTs = Date.now()

            // Detect empty response (no text AND no tool calls) — nudge the model
            if (!assistantText && rawToolCalls.length === 0 && emptyResponseCount < MAX_EMPTY_RETRIES) {
              emptyResponseCount++
              messages.push({
                role: 'system', source: 'runtime',
                content: 'Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
              })
              // Re-enter budget_check to loop back to llm_call
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            // Detect truncated response (finish_reason='length') — the model
            // hit max_tokens mid-response. Inject "continue" and retry up to 3x.
            if (finishReason === 'length' && rawToolCalls.length === 0 && lengthRetryCount < MAX_LENGTH_RETRIES) {
              lengthRetryCount++
              this.eventLog?.append('module_flag', 'length_retry', {
                retry: lengthRetryCount,
                max: MAX_LENGTH_RETRIES,
                partial_length: assistantText.length,
              })
              messages.push({
                role: 'system', source: 'runtime',
                content: 'Continue your previous response from where it was cut off. Do not repeat what you already wrote — just continue.',
              })
              state = transitionQueryState(state, { type: 'continue' })
              break
            }

            if (!assistantText && rawToolCalls.length === 0) throw new Error('Empty response after bounded retries')
            if (finishReason === null || finishReason === 'content_filter' || finishReason === 'length') {
              throw new Error('Incomplete response: ' + (finishReason ?? 'stream ended without finish reason'))
            }
            if (finishReason !== 'stop' && finishReason !== 'tool_calls') throw new Error('Unsupported finish reason: ' + finishReason)
            pendingToolCalls = rawToolCalls
            state = transitionQueryState(state, {
              type: 'llm_done',
              finishReason,
              hasToolCalls: rawToolCalls.length > 0,
              output: finalOutput,
            })
            break
          }

          case 'continuation_check': {
            // When continuation is enabled and budget remains, nudge the model
            // to keep producing instead of stopping on finish_reason=stop.
            if (enableContinuation) {
              const decision = checkTokenBudget(budgetTracker, turnTokenBudget, turnTokensProduced)
              if (decision.action === 'continue') {
                this.eventLog?.append('module_flag', 'continuation', {
                  continuation_count: decision.continuationCount,
                  pct: decision.pct,
                  turn_tokens: decision.turnTokens,
                  budget: decision.budget,
                })
                messages.push({ role: 'system', source: 'runtime', content: decision.nudgeMessage })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
            }
            // Default: stop and complete
            state = transitionQueryState(state, { type: 'stop' })
            break
          }

          case 'parse_response': {
            const validCalls: ParsedToolCall[] = []
            for (const tc of pendingToolCalls) {
              let input: Record<string, unknown>
              try {
                const parsed: unknown = JSON.parse(tc.arguments || '{}')
                // Tools require a JSON object — primitives (string/number/
                // boolean), null, and arrays are NOT valid input shapes.
                // The legacy code cast any JSON.parse result to
                // `Record<string, unknown>` regardless of shape, which
                // meant a model that emitted `null`, `[...]`, `"foo"`, or
                // `42` as arguments would reach the tool with a
                // misshaped object — tools then either crashed trying
                // to read `.foo` on null/undefined or silently produced
                // nonsense. Reject these shapes here with a clear tool-
                // result error so the LLM can retry with a real object.
                if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                  const shape = parsed === null
                    ? 'null'
                    : Array.isArray(parsed)
                      ? 'array'
                      : typeof parsed
                  this.renderer.warn(
                    `Warning: malformed tool arguments for ${tc.name} (expected JSON object, got ${shape}).`,
                  )
                  this.eventLog?.append('tool_call', tc.name, {
                    parse_error: true,
                    shape,
                    raw_args: tc.arguments.slice(0, 200),
                  })
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.name,
                    content: `Tool arguments must be a JSON object, but got ${shape}. Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with a JSON object like {"key": "value"}.`,
                  })
                  continue
                }
                input = parsed as Record<string, unknown>
              } catch {
                // Malformed JSON — do NOT execute the tool. Push a synthetic
                // error result so the LLM knows its arguments were bad.
                this.renderer.warn(`Warning: malformed tool arguments for ${tc.name} (JSON parse failed, likely truncated).`)
                this.eventLog?.append('tool_call', tc.name, { parse_error: true, raw_args: tc.arguments.slice(0, 200) })
                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: tc.name,
                  content: `Could not parse tool arguments as valid JSON (likely truncated by max_tokens). Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with shorter or simpler arguments.`,
                })
                continue  // skip this call — don't add to validCalls
              }
              validCalls.push({ tc, input })
            }

            pendingParsedCalls = validCalls

            // Track last tool name for OnError hook
            if (pendingParsedCalls.length > 0) {
              lastToolName = pendingParsedCalls[pendingParsedCalls.length - 1].tc.name
            }

            state = transitionQueryState(state, { type: 'continue' })
            break
          }

          case 'tool_execution': {
            const { aborted } = await this.scheduleToolCalls(
              pendingParsedCalls,
              toolContext,
              planMode,
              turnAbortController,
              messages,
              state.iteration,
            )

            const hardAborted = turnAbortController.signal.aborted
            state = transitionQueryState(state, {
              type: 'tools_done',
              aborted: aborted || hardAborted,
              hardAborted,
              output: finalOutput,
            })
            break
          }

          case 'boot':
            // Unreachable — boot transitions to check_abort before the loop
            state = transitionQueryState(state, { type: 'booted' })
            break
        }
      }

      // State machine reached a terminal state
      if (state.kind === 'complete') {
        result = { stopped: true, reason: state.reason, output: state.output }
      } else {
        // Defensive fallback — should never happen
        result = { stopped: true, reason: 'error', output: finalOutput }
      }
    } catch (err) {
      // Lifecycle hook: OnError
      const errMsg = (err as Error).message || String(err)
      const errorIteration = 'iteration' in state ? state.iteration : 0
      this.config.hookRunner?.runOnError?.(err as Error, {
        turnNumber: errorIteration,
        lastToolName,
      })
      // Surface the error to the user — don't swallow it silently
      this.renderer.error(`Engine error: ${errMsg}`)
      // Don't re-throw — construct error result so onComplete hooks still fire
      result = { stopped: true, reason: 'error', output: finalOutput || `[Error: ${errMsg}]` }
    } finally {
      // Inner finally: cleans up ONLY what setup reached. If the outer
      // try's setup threw before `turnAbortController` was constructed,
      // this finally never runs — the outer finally handles that case
      // with its own scope-bounded cleanup (it touches no setup-local
      // symbols).
      //
      // Ownership-aware cleanup: only release the singleton slot if it still
      // points at OUR controller. Without this check, an in-flight older
      // turn whose `finally` runs after a newer turn has installed its own
      // controller would null out the new turn's slot, making subsequent
      // `engine.abort()` calls silently no-op.

      // Ownership-aware soft-flag cleanup: if the flag is still set and its
      // owner is OUR controller (we never claimed it via check_abort),
      // clear it. If the owner is a different controller — meaning a newer
      // turn called softAbort() while we were running — preserve it so the
      // newer turn's check_abort can still see the request.
      if (this.softAbortRequested && this.softAbortOwner === turnAbortController) {
        this.softAbortRequested = false
        this.softAbortOwner = null
      }
    }

    let verification: VerificationEvidence = { status: 'not_applicable', workspace: this.config.cwd, runId: run.runId, commands: [], output: 'No artifact changes require executable checks' }
    let status = normalizeOutcome(result)
    const failures = [...run.toolFailures.values()]
    if (failures.some(failure => failure.status === 'needs_input')) status = 'needs_input'
    else if (failures.some(failure => failure.status === 'blocked')) status = 'blocked'
    else if (failures.length && status === 'completed') status = 'failed'
    if (turnAbortController.signal.aborted) status = String(turnAbortController.signal.reason).startsWith('timeout:') ? 'failed' : 'cancelled'
    if (status === 'completed') {
      try {
        const artifact = await runOperation(run, 'artifact:final', () => captureArtifactVersion(this.config.cwd, verificationPlan.excludedPaths, { signal: run.controller.signal }), 60_000, this.config.cancellationGraceMs ?? 2000)
        if (artifact !== startingArtifact) {
          verification = await runOperation(run, 'verification', () => withWorkspaceAccess(this.config.cwd, run.familyId, true, turnAbortController.signal, () => executeVerification({ cwd: this.config.cwd, plan: verificationPlan, executionProfile: this.config.executionProfile, signal: turnAbortController.signal, runId: run.runId, artifactVersion: artifact })), 300_000, this.config.cancellationGraceMs ?? 2000)
          if (verification.status === 'failed') status = 'failed'
          else if (verification.status !== 'passed' || verification.sufficientForCompletion === false) status = 'blocked'
        } else if (run.mutationAttempted) {
          status = 'blocked'
          verification = { ...verification, status: 'not_run', output: 'A file write produced no change in the artifact inventory. Explicit artifact acceptance is required for ignored outputs or unchanged writes.' }
        }
      } catch (error) {
        status = turnAbortController.signal.aborted ? 'cancelled' : 'failed'
        verification = { status: 'failed', workspace: this.config.cwd, runId: run.runId, commands: [], output: String(error) }
      }
    } else verification = { ...verification, status: 'not_run', output: 'Run was not accepted for verification' }
    result = { ...result, status, verification, runId: run.runId, unfinishedResources: [...run.pending.keys()] }
    if (status !== 'completed' && result.reason === 'stop_sequence') result.reason = status === 'interrupted' ? 'interrupted' : status === 'limit_reached' ? 'max_iterations' : 'error'
    if (run.pending.size && result.status === 'completed') result = { ...result, status: 'blocked', reason: 'error', unfinishedResources: [...run.pending.keys()] }
    run.result = result
    // ── Module onComplete hooks (reflection, etc.) ──
    for (const module of this.modules) {
      try {
        if (turnAbortController.signal.aborted) break
        await runOperation(run, 'finalize:' + module.name, () => Promise.resolve(module.onComplete?.({
          cwd: this.config.cwd,
          sessionDir: this.config.sessionDir,
          turnResult: result,
          messages,
          eventLog: this.eventLog,
          abortSignal: turnAbortController.signal,
          model: this.config.model,
        })), 60_000, this.config.cancellationGraceMs ?? 2000)
      } catch {
        // module onComplete failures must never break the engine
      }
    }

    // ── Lifecycle hook: OnComplete ──
    if (turnAbortController.signal.aborted) result = { ...result, reason: 'error', status: String(turnAbortController.signal.reason).startsWith('timeout:') ? 'failed' : 'cancelled', unfinishedResources: [...run.pending.keys()] }
    this.config.hookRunner?.runOnComplete?.(result)

    if (result.status === 'completed') {
      const acceptedArtifact = verification.artifactVersion ?? startingArtifact
      const finalArtifact = await runOperation(run, 'artifact:after-finalization', () => captureArtifactVersion(this.config.cwd, verificationPlan.excludedPaths, { signal: run.controller.signal }), 60_000, this.config.cancellationGraceMs ?? 2000)
      if (finalArtifact !== acceptedArtifact) {
        result = { ...result, reason: 'error', status: 'blocked', verification: { ...verification, status: 'failed', output: 'Artifact changed during finalization; previous acceptance is stale.' } }
      }
    }
    if (run.pending.size && result.status === 'completed') result = { ...result, status: 'blocked', reason: 'error', unfinishedResources: [...run.pending.keys()] }
    if (result.status === 'completed') run.store?.acceptance(verificationPlan.definitionHash, verification.artifactVersion ?? startingArtifact)
    run.store?.finish(result.status ?? 'unknown')
    run.result = result

    return { result, newHistory: settleHistory(messages) }
    } catch (error) {
      try { run.store?.finish('needs_recovery') } catch (failure) { this.renderer.warn('Run state could not be persisted: ' + String(failure)) }
      const status = turnAbortController.signal.aborted ? 'cancelled' : 'failed'
      return { result: { stopped: true, reason: 'error', status, runId: run.runId, output: String(error), verification: { status: 'not_run', workspace: this.config.cwd, commands: [], output: 'Initialization failed' }, unfinishedResources: [...run.pending.keys()] }, newHistory: settleHistory(messages) }
    } finally {
      quarantineRun(run)
      run.detachParent()
      this.currentTurnAbortController = null
      this.activeRun = null
      // OUTER finally: the SINGLE point that releases _turnInFlight.
      // Runs unconditionally — success, soft-abort, hard-abort, state-
      // machine catch-and-suppress, AND any throw from setup (module
      // boot, file state clear, buildSystemPrompt, buildToolContext)
      // ALL flow through here. Without this outer finally the flag
      // would leak on every setup throw, permanently locking the
      // engine against future turns.
      this._turnInFlight = false
    }
  }

  getModel(): string {
    return this.config.model
  }

  getModelClient(): OpenAI { return this.client }

  setModel(model: string): void {
    this.config.model = model
    for (const module of this.modules) module.onModelChange?.(model)
  }

  /** Expose the cost tracker for end-of-session cost display */
  getCostTracker(): CostTracker {
    return this.costTracker
  }

  /** Expose the background task manager for cleanup / inspection */
  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }

  /** Expose unified permissions for slash commands and diagnostics */
  getPermissionManager(): PermissionManager {
    return this.permissionManager
  }

  /** Whether plan mode is currently active */
  isPlanMode(): boolean {
    return this.planModeActive || this.permissionManager.getMode() === 'plan'
  }

  /**
   * Expose the live EngineConfig reference so slash commands (e.g. /poor)
   * can mutate fields and have modules see the change immediately. The
   * returned object is the SAME reference modules hold via ModuleContext.config,
   * so mutations propagate live.
   */
  getConfig(): EngineConfig {
    return this.config
  }

  /** Exit plan mode — called by the ExitPlanMode tool after user approval */
  exitPlanMode(): void {
    this.planModeActive = false
    if (this.permissionManager.getMode() === 'plan') this.permissionManager.setMode('default')
    this.config.planMode = false
    if (this.activeRun) this.activeRun.policyRevision++
  }

  /** Enter plan mode — called by the EnterPlanMode tool */
  enterPlanMode(): void {
    this.planModeActive = true
    this.config.planMode = true
    if (this.activeRun) this.activeRun.policyRevision++
  }

  /**
   * Queue a manual "snip" for the start of the next `runTurn`.
   * Called by the `/snip [N]` slash command. Drops all but the most
   * recent `keepRecent` messages and inserts a `[snip]` boundary marker
   * before the first LLM call of the next turn.
   *
   * The snip is applied at runTurn entry — not synchronously here —
   * because the messages array lives inside `runTurn` and we don't have
   * a stable reference outside it.
   */
  queueSnip(keepRecent: number): void {
    if (!Number.isSafeInteger(keepRecent) || keepRecent < 0) throw new Error('keepRecent must be a finite non-negative integer')
    this.pendingSnipCount = keepRecent
  }

  /**
   * Mutate `messages` in place: drop all but the last `keepRecent`
   * entries, prepend a `[snip]` boundary marker, log the event, and
   * return `{ removed, tokensFreed }`. Shared by the `Snip` tool
   * (mid-turn) and the queued-from-slash-command path (pre-turn).
   *
   * `removed` reflects how many messages were actually dropped — when
   * the conversation is already shorter than `keepRecent`, nothing
   * happens and `removed === 0`.
   */
  private applySnipToMessages(
    messages: OpenAIMessage[],
    keepRecent: number,
    reason: string | undefined,
  ): { removed: number; tokensFreed: number } {
    const total = messages.length
    const kept = trimHistory(messages, keepRecent)
    const removeCount = total - kept.length
    if (removeCount === 0) {
      return { removed: 0, tokensFreed: 0 }
    }

    const tokensBefore = estimateTokens(messages)
    const boundary: OpenAIMessage = {
      role: 'system', source: 'runtime',
      content:
        `[snip] ${removeCount} older messages were removed to free context space` +
        (reason ? ` (${reason})` : '') +
        '. Continue working from the current context — earlier details are no longer available.',
    }

    // Mutate in place — same pattern as `microCompact` / `maybeCompact`
    messages.length = 0
    messages.push(boundary, ...kept)

    const tokensAfter = estimateTokens(messages)

    this.eventLog?.append('context_compact', 'snip', {
      type: 'manual_snip',
      removed: removeCount,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      tokens_freed: tokensBefore - tokensAfter,
      reason: reason ?? null,
    })

    return { removed: removeCount, tokensFreed: tokensBefore - tokensAfter }
  }

  /** Get the file history tracker (null if no sessionDir) */
  getFileHistory(): FileHistory | null {
    return this.fileHistory
  }
}

// Export partitionToolCalls for testing
export { partitionToolCalls, enforceAggregateToolResultBudget }
