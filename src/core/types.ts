// Core types for ovolv999 execution engine

import type { EventLog } from './eventLog.js'
import type { SemanticMemory } from './semanticMemory.js'
import type { EpisodicMemory } from './episodicMemory.js'
import type { AgentConfig } from './agentPresets.js'

// OpenAI-compatible tool call format
export interface ToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: {
      type: 'object'
      properties: Record<string, unknown>
      required?: string[]
    }
  }
}

export interface ToolResult {
  content: string
  isError: boolean
}

export interface Tool {
  name: string
  definition: ToolDefinition
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>
  /**
   * Per-input concurrency check (Claude Code pattern).
   * If implemented, engine uses this instead of the static CONCURRENCY_SAFE_TOOLS set.
   * Returns true if this specific call can run in parallel with other safe calls.
   * Default (not implemented) → falls back to static set.
   */
  isConcurrencySafe?(input: Record<string, unknown>): boolean
}

export interface ToolContext {
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  /** AbortSignal — tools should honour this to support Ctrl+C cancellation */
  signal?: AbortSignal
  /** Progress update function for long-running tools */
  updateProgress?: (progress: number, recoveryData?: Record<string, unknown>) => void
  /**
   * API config forwarded from engine — allows tools that need LLM calls
   * (e.g. image analysis via vision API) to reuse the same endpoint + key.
   */
  apiConfig?: { apiKey: string; baseURL?: string; model: string }
  /** Session output directory — for tools that need to write artifacts
   * (e.g. generated files, logs, reports). */
  sessionDir?: string
  /** Event log for audit trail — best-effort, never throws */
  eventLog?: EventLog
  /** Semantic memory — cross-turn knowledge persistence */
  semanticMemory?: SemanticMemory
  /** Episodic memory — action trajectory persistence */
  episodicMemory?: EpisodicMemory
  /** Tool names available to this agent — used for skill permission checks */
  availableToolNames?: string[]
}

/**
 * Interface for hook runners — decouples engine from config layer.
 * Hooks are best-effort: implementations must never throw.
 */
export interface IHookRunner {
  runPreToolCall(toolName: string, input: Record<string, unknown>): void
  runPostToolCall(toolName: string, result: string, isError: boolean): void
  runUserPromptSubmit(prompt: string): void
  /** Called when the engine encounters an unrecoverable error */
  runOnError?(error: Error, context: { turnNumber: number; lastToolName?: string }): void
  /** Called when a run completes (any reason: stop, max_iterations, error, interrupted) */
  runOnComplete?(result: TurnResult): void
  /** Called after context compaction (auto-summary of older messages) */
  runOnContextOverflow?(tokensBefore: number, tokensAfter: number): void
}

export interface EngineConfig {
  model: string
  baseURL?: string
  apiKey: string
  maxIterations: number
  cwd: string
  permissionMode: 'auto' | 'ask' | 'deny'
  systemPrompt?: string
  /** Extra tools to inject (e.g. MCP tools) */
  extraTools?: Tool[]
  /**
   * Plan mode: restrict tools to read-only (Read, Glob, Grep, WebFetch, WebSearch).
   * The agent analyzes and plans but cannot write, edit, or execute.
   */
  planMode?: boolean
  /** Hook runner for PreToolCall / PostToolCall / UserPromptSubmit events */
  hookRunner?: IHookRunner
  /** Session output directory — injected into sub-agent prompts */
  sessionDir?: string
  /** Maximum context window in tokens for the selected model.
   * Defaults to 200_000 (claude-sonnet-4-x).  Used to compute percentage-based
   * compact/warn thresholds instead of a flat token count.
   */
  maxContextTokens?: number
  /** LLM sampling temperature (default: 0) */
  temperature?: number
  /** Max output tokens per LLM response (default: 8192) */
  maxOutputTokens?: number
  /** Event log for audit trail */
  eventLog?: EventLog
  /** Semantic memory — cross-turn knowledge persistence */
  semanticMemory?: SemanticMemory
  /** Episodic memory — action trajectory persistence */
  episodicMemory?: EpisodicMemory
  /**
   * Enabled module names — determines which capability modules are active.
   * If omitted, the engine auto-enables modules based on available config
   * (memory if semanticMemory set, critic if sessionDir set, workspace if
   * sessionDir set). Set to [] for a lightweight agent with no modules.
   */
  enabledModules?: string[]
  /** Agent configuration — composable identity + modules + tools.
   * When set, overrides systemPrompt / planMode / enabledModules / etc.
   * Replaces the legacy AgentType enum with config-driven differentiation.
   */
  agent?: AgentConfig
}

export interface TurnResult {
  stopped: boolean
  /**
   * stop_sequence  — LLM returned finish_reason=stop with no tool calls
   * max_iterations — hit maxIterations ceiling
   * error          — hard abort (Ctrl+C × 2) or unrecoverable API error
   * interrupted    — soft pause requested (Ctrl+C × 1), partial history preserved
   */
  reason: 'max_iterations' | 'stop_sequence' | 'error' | 'interrupted'
  output: string
}
