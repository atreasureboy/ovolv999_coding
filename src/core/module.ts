/**
 * Module System — composable capability extensions for the unified Harness.
 *
 * Core principle (from AgentOS): all agents share one runtime (Harness).
 * Differentiated capabilities come from enabling/disabling modules, NOT from
 * hardcoded agent_type enums.
 *
 * Lifecycle hooks:
 *   boot()        — called once before the engine loop starts
 *   onIteration() — called at the top of each loop iteration
 *   onToolCall()  — called after each tool execution
 *   onComplete()  — called after the engine loop finishes
 */

import type OpenAI from 'openai'
import type { Tool, ToolContext, ToolResult, OpenAIMessage, TurnResult, EngineConfig } from './types.js'
import type { EventLog } from './eventLog.js'

/** Context passed to module factories — provides shared dependencies */
export interface ModuleContext {
  client: OpenAI
  model: string
  config: EngineConfig
}

/** Factory that creates a module instance from shared context */
export type ModuleFactory = (ctx: ModuleContext) => AgentModule

/** Context passed to module.boot() */
export interface ModuleBootContext {
  cwd: string
  abortSignal?: AbortSignal
  model?: string
  sessionDir?: string
  config: EngineConfig
  /** The user's message for this run — used for relevance-based memory retrieval */
  userMessage?: string
}

/** Return value of module.boot() — what the module injects into the run */
export interface ModuleBootResult {
  /** Additional system prompt sections to inject */
  systemPromptSections?: string[]
  /** Additional tools this module provides */
  tools?: Tool[]
  /** Fields to merge into ToolContext */
  toolContextPatch?: Partial<ToolContext>
}

/** Context passed to module.onIteration() */
export interface ModuleIterationContext {
  iteration: number
  messages: OpenAIMessage[]
  abortSignal: AbortSignal
}

/** Return value of module.onIteration() — can inject a message into the conversation */
export interface ModuleIterationResult {
  /** If set, this message is injected as a user message before the LLM call */
  injectMessage?: string
}

/** Context passed to module.onComplete() */
export interface ModuleRunContext {
  cwd: string
  abortSignal?: AbortSignal
  model?: string
  sessionDir?: string
  turnResult: TurnResult
  messages: OpenAIMessage[]
  eventLog?: EventLog
}

/**
 * Agent Module — a composable capability extension.
 *
 * Implementations: MemoryModule, CriticModule, WorkspaceModule, ReflectionModule.
 * Custom modules can be registered via ModuleRegistry.register().
 */
export interface AgentModule {
  readonly name: string
  onModelChange?(model: string): void
  dispose?(): void | Promise<void>
  /** Modules that must be enabled before this one (resolved by registry) */
  readonly dependencies?: string[]

  /** Boot Sequence — inject prompt sections, tools, context patches */
  boot(ctx: ModuleBootContext): ModuleBootResult | Promise<ModuleBootResult>

  /** Called at the top of each engine loop iteration (e.g. critic check) */
  onIteration?(ctx: ModuleIterationContext): void | Promise<ModuleIterationResult | void>

  /** Called after each tool execution (e.g. episodic memory write) */
  onToolCall?(
    toolName: string,
    input: Record<string, unknown>,
    result: ToolResult,
    turnNumber: number,
  ): void

  /** Called after the engine loop finishes (e.g. reflection knowledge extraction) */
  onComplete?(ctx: ModuleRunContext): void | Promise<void>
}
