import { assertExecutionProfile, createProcessScope } from './executionBackend.js'
import { settleHistory, trimHistory } from './messageGroups.js'
import { createModelGateway } from './modelGateway.js'
import { randomUUID } from 'crypto'
import OpenAI from 'openai'
import { getPlanModePrefix } from '../prompts/system.js'
import { createTools, findTool, getToolDefinitions } from '../tools/index.js'
import { applyAgentToConfig } from './agentPresets.js'
import { BackgroundTaskManager } from './backgroundTaskManager.js'
import {
  CONTEXT_COMPACT_PCT,
  CONTEXT_MICROCOMPACT_PCT,
  CONTEXT_WARN_PCT,
  clampMaxOutputTokens,
  effectiveInputBudget,
  estimateTokens,
  estimateToolDefinitionTokens,
  getCompressionStrategy,
  maybeCompact,
  maybeTimeBasedMicroCompact,
  microCompact,
  resolveContextWindow,
} from './compact.js'
import { CostTracker, type TokenUsage } from './costTracker.js'
import { acceptRunResult } from './engine/acceptance.js'
import type { EngineObserver } from './engine/observer.js'
import { consumeModelStream, type ModelResponse } from './engine/responseStream.js'
import {
  allowedAgentToolNames,
  isPlanModeTool,
  partitionToolCalls,
  type ParsedToolCall,
  type StreamingToolCall,
} from './engine/toolPolicy.js'
import { enforceAggregateToolResultBudget, truncateToolResult } from './engine/toolResults.js'
import { FileHistory } from './fileHistory.js'
import type { AgentModule, ModuleBootContext, ModuleBootResult } from './module.js'
import { globalModuleRegistry } from './moduleRegistry.js'
import { settleWithin } from './outcome.js'
import { PermissionManager, checkRules } from './permissionSystem.js'
import {
  checkTokenBudget,
  createBudgetTracker,
  isTerminal,
  transitionQueryState,
  type QueryState,
} from './queryStateMachine.js'
import { classifyCommandRisk } from './riskClassifier.js'
import {
  createRunContext,
  initializeRunStore,
  isWorkspaceQuarantined,
  quarantineRun,
  quarantineWorkspace,
  runOperation,
  withWorkspaceAccess,
  type RunContext,
} from './runContext.js'
import { normalizeCJKInput } from './strings.js'
import type {
  ContentPart,
  EngineConfig,
  OpenAIMessage,
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
  TurnResult,
} from './types.js'
import { captureArtifactVersion, createVerificationPlan } from './verification.js'
function isContextOverflowError(message: string): boolean {
  return (
    message.includes('context_length_exceeded') ||
    message.includes('maximum context length') ||
    /context[\s_-]{0,80}(?:is\s+)?too\s+long/i.test(message) ||
    /too\s+long[\s_-]{0,80}(?:context|tokens?|input|window|limit)/i.test(message)
  )
}
export class ExecutionEngine {
  private client: OpenAI
  private tools: Tool[]
  private config: EngineConfig
  private renderer: EngineObserver
  private currentTurnAbortController: AbortController | null = null
  private softAbortRequested = false
  private softAbortOwner: AbortController | null = null
  private eventLog: EngineConfig['eventLog']
  private modules: AgentModule[]
  private systemPromptTokens = 0
  private allTools: Tool[]
  private costTracker: CostTracker
  private backgroundTaskManager: BackgroundTaskManager
  private planModeActive: boolean
  private fileHistory: FileHistory | null
  private permissionManager: PermissionManager
  private _streamUsageSupported = true
  private _consecutiveCompactFailures = 0
  private _suppressCompactWarning = false
  private _turnInFlight = false
  private activeRun: RunContext | null = null
  private disposal: Promise<void> | null = null
  private disposed = false
  private lastAssistantTs: number | undefined = undefined
  private pendingSnipCount: number | null = null
  private getModelContextWindow(): number {
    return resolveContextWindow(this.config.model, this.config.maxContextTokens)
  }
  private getEffectiveMaxOutputTokens(): number {
    return clampMaxOutputTokens(this.config.maxOutputTokens, this.getModelContextWindow())
  }
  constructor(config: EngineConfig, renderer: EngineObserver, client?: OpenAI) {
    assertExecutionProfile(config.executionProfile)
    this.config = applyAgentToConfig({
      ...config,
      extraTools: config.extraTools ? [...config.extraTools] : undefined,
      enabledModules: config.enabledModules ? [...config.enabledModules] : undefined,
      verificationExcludedPaths: config.verificationExcludedPaths
        ? [...config.verificationExcludedPaths]
        : undefined,
      poor: config.poor ? { ...config.poor } : undefined,
      mcp: config.mcp ? { servers: structuredClone(config.mcp.servers) } : undefined,
      agent: config.agent
        ? {
            ...config.agent,
            identity: { ...config.agent.identity },
            tools: config.agent.tools ? [...config.agent.tools] : undefined,
            disallowedTools: config.agent.disallowedTools
              ? [...config.agent.disallowedTools]
              : undefined,
            modules: config.agent.modules ? structuredClone(config.agent.modules) : undefined,
          }
        : undefined,
    })
    config = this.config
    this.renderer = renderer
    this.client =
      client ??
      new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: 0,
        timeout: 120000,
      })
    this.client = createModelGateway(this.client, this.config, () => this.activeRun)
    this.tools = config.agentFactory
      ? createTools(config.extraTools ?? [], {
          factory: config.agentFactory,
          parentConfig: config,
          parentRenderer: renderer,
        })
      : createTools(config.extraTools ?? [])
    this.allTools = this.tools
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
    const enabledNames = this.deriveEnabledModules()
    this.modules =
      enabledNames.length > 0
        ? globalModuleRegistry.resolve(enabledNames, {
            client: this.client,
            model: config.model,
            config,
          })
        : []
  }
  private deriveEnabledModules(): string[] {
    if (this.config.enabledModules !== undefined) {
      return this.config.enabledModules
    }
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
  abort(): void {
    this.currentTurnAbortController?.abort('user_cancelled')
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal
    this.disposed = true
    this.abort()
    this.disposal = (async () => {
      const failures: string[] = []
      const resources: Array<[string, () => void | Promise<void>]> = [
        ...[...(this.activeRun?.pending.entries() ?? [])].map(
          ([name, pending]) =>
            [
              name,
              () =>
                pending.then(
                  () => {},
                  () => {},
                ),
            ] as [string, () => Promise<void>],
        ),
        ['background', () => this.backgroundTaskManager.dispose()],
        ...this.modules.map(
          (module) =>
            [module.name, () => module.dispose?.()] as [string, () => void | Promise<void>],
        ),
      ]
      for (const [name, cleanup] of resources) {
        const pending = Promise.resolve().then(cleanup)
        try {
          await settleWithin(pending, this.config.cancellationGraceMs ?? 2000)
        } catch {
          quarantineWorkspace(this.config.cwd, pending)
          failures.push(name)
          this.renderer.warn('Resource cleanup incomplete: ' + name)
        }
      }
      if (failures.length) throw new Error('Resource cleanup incomplete: ' + failures.join(', '))
    })()
    return this.disposal
  }
  softAbort(): void {
    this.softAbortRequested = true
    this.softAbortOwner = this.currentTurnAbortController
  }
  private claimSoftAbort(turnAbortController: AbortController): boolean {
    if (!this.softAbortRequested) return false
    if (this.softAbortOwner !== null && this.softAbortOwner !== turnAbortController) {
      return false
    }
    this.softAbortRequested = false
    this.softAbortOwner = null
    return true
  }
  private buildSystemPrompt(planMode: boolean, moduleSections: string[] = []): string {
    const baseSystemPrompt = this.config.systemPrompt ?? ''
    const sections =
      moduleSections.length > 0
        ? baseSystemPrompt + '\n\n---\n\n' + moduleSections.join('\n\n---\n\n')
        : baseSystemPrompt
    if (planMode) {
      return getPlanModePrefix() + sections
    }
    return sections
  }
  private getToolDefinitions(planMode: boolean, moduleTools: Tool[] = []): ToolDefinition[] {
    const allTools = [...this.tools, ...moduleTools]
    const allowed = allowedAgentToolNames(
      allTools.map((tool) => tool.definition.function.name),
      this.config,
    )
    return getToolDefinitions(allTools).filter(
      (def) =>
        allowed.has(def.function.name) &&
        (!planMode ||
          isPlanModeTool(
            allTools.find((tool) => tool.name === def.function.name),
            def.function.name,
          )),
    )
  }
  private async evaluateContextBudget(
    messages: OpenAIMessage[],
    toolDefs?: ReturnType<typeof getToolDefinitions>,
    turnAbortSignal?: AbortSignal,
  ): Promise<void> {
    const suppressCompactWarning = this._suppressCompactWarning
    this._suppressCompactWarning = false
    const maxCtxTokens = this.getModelContextWindow()
    const messageTokens = estimateTokens(messages)
    const toolDefTokens = estimateToolDefinitionTokens(toolDefs)
    const totalTokens = messageTokens + this.systemPromptTokens + toolDefTokens
    const inputBudget = effectiveInputBudget(maxCtxTokens, this.config.maxOutputTokens)
    const pct = totalTokens / inputBudget
    const shouldMicroCompact = pct >= CONTEXT_MICROCOMPACT_PCT
    const shouldWarn = pct >= CONTEXT_WARN_PCT
    const shouldCompact = pct >= CONTEXT_COMPACT_PCT
    const strategy = getCompressionStrategy(pct)
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
        this.renderer.compactDone(compactResult.originalTokens, compactResult.summaryTokens)
        this.eventLog?.append('context_compact', 'engine', {
          tokens_after: compactResult.summaryTokens,
          reduction: compactResult.originalTokens - compactResult.summaryTokens,
        })
        this._consecutiveCompactFailures = 0
        this._suppressCompactWarning = true
        this.config.hookRunner?.runOnContextOverflow?.(
          compactResult.originalTokens,
          compactResult.summaryTokens,
        )
      } else {
        this._consecutiveCompactFailures++
        if (this._consecutiveCompactFailures >= 3) {
          this.renderer.warn(
            `Auto-compact failed ${this._consecutiveCompactFailures} consecutive times — skipping further attempts. Consider starting a new session.`,
          )
        }
      }
    }
  }
  private async callLLM(
    systemPrompt: string,
    messages: OpenAIMessage[],
    toolDefs: ToolDefinition[],
    turnAbortSignal: AbortSignal,
  ): Promise<ModelResponse> {
    this.renderer.startSpinner()
    const callStartMs = Date.now()
    const createStream = (): Promise<AsyncIterable<OpenAI.Chat.ChatCompletionChunk>> =>
      this.client.chat.completions.create(
        {
          model: this.config.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...(messages as OpenAI.Chat.ChatCompletionMessageParam[]),
          ],
          tools: toolDefs.length ? toolDefs : undefined,
          tool_choice: toolDefs.length ? 'auto' : undefined,
          temperature: this.config.temperature ?? 0,
          max_tokens: this.getEffectiveMaxOutputTokens(),
          stream: true,
          ...(this._streamUsageSupported ? { stream_options: { include_usage: true } } : {}),
        },
        { signal: turnAbortSignal },
      )
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    try {
      stream = await createStream()
    } catch (error) {
      this.renderer.stopSpinner()
      const message = error instanceof Error ? error.message : ''
      if (message.includes('stream_options')) {
        this._streamUsageSupported = false
      } else if (isContextOverflowError(message)) {
        this.renderer.warn('Context too long — auto-compacting and retrying...')
        const compact = await maybeCompact(
          this.client,
          this.config.model,
          messages,
          turnAbortSignal,
        )
        if (!compact.compacted) throw error
        messages.splice(0, messages.length, ...compact.messages)
        this.renderer.compactDone(compact.originalTokens, compact.summaryTokens)
      } else {
        throw error
      }
      stream = await createStream()
    }
    const result = await consumeModelStream(
      stream,
      turnAbortSignal,
      this.renderer,
      this.currentTurnAbortController,
    )
    this.recordUsage(result.usage, callStartMs)
    return result
  }
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
  private async executeToolCall(
    toolName: string,
    input: Record<string, unknown>,
    context: ToolContext,
    turnNumber: number,
  ): Promise<ToolResult> {
    const tool = findTool(this.allTools, toolName)
    if (!tool) {
      return { content: `Unknown tool: ${toolName}`, isError: true }
    }
    if (this.isPlanMode() && !isPlanModeTool(tool, toolName)) {
      return {
        content: `Tool "${toolName}" is not available in plan mode. Only read-only tools are allowed. Output your plan as text.`,
        isError: true,
      }
    }
    if (
      !allowedAgentToolNames(
        this.allTools.map((tool) => tool.name),
        this.config,
      ).has(toolName)
    ) {
      return { content: `Tool "${toolName}" is not available to this agent.`, isError: true }
    }
    const isDangerous =
      (toolName === 'ExitWorktree' && input.action === 'discard') ||
      (toolName === 'Bash' && typeof input.command === 'string'
        ? classifyCommandRisk(input.command) === 'dangerous'
        : false)
    const managerPermission = this.permissionManager.check(toolName, input, isDangerous)
    const permission =
      managerPermission === 'deny'
        ? 'deny'
        : this.config.permissionMode === 'deny' && tool.metadata?.readOnly !== true
          ? 'deny'
          : this.config.permissionMode === 'ask' &&
              tool.metadata?.readOnly !== true &&
              this.permissionManager.getMode() === 'default' &&
              checkRules(this.permissionManager.getRules(), toolName, input)?.behavior !== 'allow'
            ? 'ask'
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
        return {
          content: `Approval required for ${toolName}; no approval channel is available.`,
          isError: true,
          status: 'needs_input',
        }
      }
    }
    context.signal?.throwIfAborted()
    const run = this.activeRun
    const operationId = run?.store?.intent(toolName, tool.metadata?.readOnly === true)
    const processScope = createProcessScope(this.config.executionProfile)
    const result = await processScope.run(() =>
      tool.execute(input, { ...context, permissionApproved }),
    )
    if (operationId && run?.store) {
      if (processScope.pending.size) {
        const receipt = Promise.all([...processScope.pending]).then(() =>
          run.store!.receipt(operationId, result.isError ? 'failed' : 'completed'),
        )
        run.pending.set('physical:' + operationId, receipt)
        void receipt.then(
          () => run.pending.delete('physical:' + operationId),
          () => run.controller.abort('RunStore receipt persistence failed'),
        )
      } else run.store.receipt(operationId, result.isError ? 'failed' : 'completed')
    }
    if (!result.isError && ['Write', 'Edit', 'NotebookEdit'].includes(toolName) && this.activeRun)
      this.activeRun.mutationAttempted = true
    if (context.signal?.aborted)
      return {
        ...result,
        isError: true,
        status: 'cancelled',
        content: 'Cancelled after physical tool completion: ' + result.content,
      }
    for (const module of this.modules) {
      await module.onToolCall?.(toolName, input, result, turnNumber)
    }
    return result
  }
  private async scheduleToolCalls(
    parsedCalls: ParsedToolCall[],
    toolContext: ToolContext,
    turnAbortController: AbortController,
    messages: OpenAIMessage[],
    turnNumber: number,
  ): Promise<{
    aborted: boolean
  }> {
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
      this.eventLog?.append('tool_result', tc.name, {
        content: result.content.slice(0, 500),
        isError: result.isError,
        status: result.status,
        run_id: run.runId,
      })
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        name: tc.name,
        content: truncateToolResult(
          result.content.trim() || '(' + tc.name + ' returned no output)',
          this.config.sessionDir,
        ),
      })
    }
    const execute = async (call: ParsedToolCall): Promise<ToolResult> => {
      const { tc, input } = call
      if (signal.aborted)
        return { content: 'Cancelled before execution', isError: true, status: 'cancelled' }
      try {
        this.renderer.toolStart(tc.name, input)
        this.config.hookRunner?.runPreToolCall(tc.name, input)
        this.eventLog?.append('tool_call', tc.name, { input, run_id: run.runId })
        const tool = findTool(this.allTools, tc.name)
        const readOnly =
          tool?.metadata?.readOnly === true ||
          (tc.name === 'Bash' && tool?.isConcurrencySafe?.(input) === true)
        return await runOperation(
          run,
          'tool:' + tc.name,
          () =>
            withWorkspaceAccess(toolContext.cwd, run.familyId, !readOnly, signal, () =>
              this.executeToolCall(tc.name, input, toolContext, turnNumber),
            ),
          this.config.toolTimeoutMs ?? 1800000,
          this.config.cancellationGraceMs ?? 2000,
        )
      } catch (error) {
        return {
          content: (error as Error).message ?? String(error),
          isError: true,
          status: signal.aborted
            ? 'cancelled'
            : (error as Error).name === 'WorkspaceUnavailableError'
              ? 'blocked'
              : 'failed',
        }
      }
    }
    try {
      for (const batch of batches) {
        for (let offset = 0; offset < batch.calls.length; offset += limit) {
          if (signal.aborted || interrupted) break
          const calls = batch.calls.slice(offset, offset + limit)
          const results = await Promise.all(calls.map(execute))
          const budgeted = results.map((result, index) => ({
            content: result.content,
            tc: calls[index].tc,
          }))
          enforceAggregateToolResultBudget(budgeted, this.config.sessionDir)
          calls.forEach((call, index) =>
            publish(call, { ...results[index], content: budgeted[index].content }),
          )
          if (this.claimSoftAbort(turnAbortController)) interrupted = true
          if (results.some((result) => result.status === 'needs_input')) interrupted = true
        }
        if (signal.aborted || interrupted) break
      }
    } finally {
      for (const call of parsedCalls) {
        if (!settled.has(call.tc.id))
          publish(call, {
            content: 'Cancelled before execution; no side effects started',
            isError: true,
            status: 'cancelled',
          })
      }
    }
    return { aborted: signal.aborted || interrupted }
  }
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
      verificationExcludedPaths: [
        ...(this.config.verificationExcludedPaths ?? []),
        ...(this.config.sessionDir ? [this.config.sessionDir] : []),
      ],
      signal: turnAbortSignal,
      apiConfig: {
        apiKey: this.config.apiKey,
        baseURL: this.config.baseURL,
        model: this.config.model,
      },
      eventLog: this.eventLog,
      backgroundTaskManager: this.backgroundTaskManager,
      askUserQuestion: this.config.askUserQuestion,
      exitPlanMode: this.config.exitPlanMode
        ? async (plan: string): Promise<boolean> => {
            const approved = (await this.config.exitPlanMode?.(plan)) ?? false
            turnAbortSignal.throwIfAborted()
            if (approved) this.exitPlanMode()
            return approved
          }
        : undefined,
      enterPlanMode: () => {
        this.enterPlanMode()
      },
      fileHistory: this.fileHistory ?? undefined,
      ...modulePatches,
    }
  }
  async runTurn(
    userMessage: string,
    history: OpenAIMessage[],
    images?: Array<{
      path: string
      dataUrl: string
    }>,
  ): Promise<{
    result: TurnResult
    newHistory: OpenAIMessage[]
  }> {
    if (this._turnInFlight) {
      throw new Error(
        'ExecutionEngine.runTurn rejected: another turn is already in progress on this engine instance. ' +
          'Each ExecutionEngine is single-turn; await the in-flight turn or spawn a new engine via EngineConfig.agentFactory.',
      )
    }
    if (this.disposed) throw new Error('ExecutionEngine is disposed')
    if (isWorkspaceQuarantined(this.config.cwd)) {
      return {
        result: {
          stopped: true,
          reason: 'error',
          status: 'blocked',
          output:
            'Workspace has unfinished operations from a previous run; wait for resource settlement.',
          verification: {
            status: 'not_run',
            workspace: this.config.cwd,
            commands: [],
            output: 'Workspace quarantined',
          },
        },
        newHistory: history,
      }
    }
    this._turnInFlight = true
    const run = createRunContext(this.config)
    this.activeRun = run
    const turnAbortController = run.controller
    this.currentTurnAbortController = turnAbortController
    let result: TurnResult
    let messages: OpenAIMessage[] = [
      ...settleHistory(history),
      { role: 'user', content: userMessage },
    ]
    try {
      initializeRunStore(run)
      const planMode = this.isPlanMode()
      const verificationPlan = createVerificationPlan(this.config.cwd, undefined, [
        ...(this.config.verificationExcludedPaths ?? []),
        ...(this.config.sessionDir ? [this.config.sessionDir] : []),
      ])
      const startingArtifact = await runOperation(
        run,
        'artifact:snapshot',
        () =>
          captureArtifactVersion(this.config.cwd, verificationPlan.excludedPaths, {
            signal: run.controller.signal,
          }),
        60000,
        this.config.cancellationGraceMs ?? 2000,
      )
      run.store?.acceptance(verificationPlan.definitionHash, startingArtifact)
      const bootCtx: ModuleBootContext = {
        cwd: this.config.cwd,
        sessionDir: this.config.sessionDir,
        config: this.config,
        userMessage,
        abortSignal: turnAbortController.signal,
        model: this.config.model,
      }
      const moduleBootResults: ModuleBootResult[] = []
      for (const module of this.modules) {
        moduleBootResults.push(
          await runOperation(
            run,
            'boot:' + module.name,
            () => Promise.resolve(module.boot(bootCtx)),
            60000,
            this.config.cancellationGraceMs ?? 2000,
          ),
        )
      }
      const moduleSections = moduleBootResults.flatMap((r) => r.systemPromptSections ?? [])
      const toolContextPatch = moduleBootResults.reduce(
        (acc, r) => ({ ...acc, ...r.toolContextPatch }),
        {} as Partial<ToolContext>,
      )
      const moduleTools = moduleBootResults.flatMap((r) => r.tools ?? [])
      this.allTools = [...this.tools, ...moduleTools]
      this.eventLog?.append('boot_context', 'engine', {
        trajectory: 'boot_context',
        modules: this.modules.map((m) => m.name),
        module_sections: moduleSections.length,
        module_tools: moduleTools.length,
        user_message_length: userMessage.length,
      })
      let systemPrompt = this.buildSystemPrompt(planMode, moduleSections)
      this.systemPromptTokens = Math.ceil(systemPrompt.length / 3.5) + 20
      let toolDefs = this.getToolDefinitions(planMode, moduleTools)
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
      if (this.pendingSnipCount !== null) {
        const queuedKeep = this.pendingSnipCount
        this.pendingSnipCount = null
        this.applySnipToMessages(messages, queuedKeep, 'queued via /snip')
      }
      const toolContext = this.buildToolContext(turnAbortController.signal, {
        ...toolContextPatch,
        availableToolNames: toolDefs.map((t) => t.function.name),
        snipMessages: (keepRecent: number, reason?: string) =>
          this.applySnipToMessages(messages, keepRecent, reason),
        getMessages: () => messages.map((m) => ({ ...m })),
      })
      let state: QueryState = transitionQueryState({ kind: 'boot' }, { type: 'booted' })
      let finalOutput = ''
      let lastToolName: string | undefined
      let pendingToolCalls: StreamingToolCall[] = []
      let pendingParsedCalls: ParsedToolCall[] = []
      const enableContinuation = this.config.enableContinuation ?? false
      const turnTokenBudget = this.config.turnTokenBudget ?? this.getEffectiveMaxOutputTokens() * 4
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
                this.renderer.warn(`Max iterations (${this.config.maxIterations}) reached`)
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
                const iterResult = await runOperation(
                  run,
                  'iteration:' + module.name,
                  () =>
                    Promise.resolve(
                      module.onIteration?.({
                        iteration,
                        messages,
                        abortSignal: turnAbortController.signal,
                      }),
                    ),
                  60000,
                  this.config.cancellationGraceMs ?? 2000,
                )
                if (iterResult?.injectMessage) {
                  const msg = iterResult.injectMessage
                  const lines = msg.split('\n').filter((l) => l.trim())
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
              toolContext.availableToolNames = toolDefs.map((def) => def.function.name)
              await this.evaluateContextBudget(messages, toolDefs, turnAbortController.signal)
              const { assistantText, finishReason, rawToolCalls } = await runOperation(
                run,
                'model:stream',
                () => this.callLLM(systemPrompt, messages, toolDefs, turnAbortController.signal),
                300000,
                this.config.cancellationGraceMs ?? 2000,
              )
              if (assistantText) {
                finalOutput += assistantText
                turnTokensProduced += Math.ceil(assistantText.length / 3.5)
              }
              const knownIds = new Set(
                messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
              )
              for (const call of rawToolCalls) {
                if (knownIds.has(call.id)) call.id = `call_${randomUUID()}`
                knownIds.add(call.id)
              }
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
              this.lastAssistantTs = Date.now()
              if (
                !assistantText &&
                rawToolCalls.length === 0 &&
                emptyResponseCount < MAX_EMPTY_RETRIES
              ) {
                emptyResponseCount++
                messages.push({
                  role: 'system',
                  source: 'runtime',
                  content:
                    'Your previous response was empty (no text, no tool call). Please respond with text or invoke a tool.',
                })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
              if (
                finishReason === 'length' &&
                rawToolCalls.length === 0 &&
                lengthRetryCount < MAX_LENGTH_RETRIES
              ) {
                lengthRetryCount++
                this.eventLog?.append('module_flag', 'length_retry', {
                  retry: lengthRetryCount,
                  max: MAX_LENGTH_RETRIES,
                  partial_length: assistantText.length,
                })
                messages.push({
                  role: 'system',
                  source: 'runtime',
                  content:
                    'Continue your previous response from where it was cut off. Do not repeat what you already wrote — just continue.',
                })
                state = transitionQueryState(state, { type: 'continue' })
                break
              }
              if (!assistantText && rawToolCalls.length === 0)
                throw new Error('Empty response after bounded retries')
              if (
                finishReason === null ||
                finishReason === 'content_filter' ||
                finishReason === 'length'
              ) {
                throw new Error(
                  'Incomplete response: ' + (finishReason ?? 'stream ended without finish reason'),
                )
              }
              if (finishReason !== 'stop' && finishReason !== 'tool_calls')
                throw new Error('Unsupported finish reason: ' + finishReason)
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
              if (enableContinuation) {
                const decision = checkTokenBudget(
                  budgetTracker,
                  turnTokenBudget,
                  turnTokensProduced,
                )
                if (decision.action === 'continue') {
                  this.eventLog?.append('module_flag', 'continuation', {
                    continuation_count: decision.continuationCount,
                    pct: decision.pct,
                    turn_tokens: decision.turnTokens,
                    budget: decision.budget,
                  })
                  messages.push({
                    role: 'system',
                    source: 'runtime',
                    content: decision.nudgeMessage,
                  })
                  state = transitionQueryState(state, { type: 'continue' })
                  break
                }
              }
              state = transitionQueryState(state, { type: 'stop' })
              break
            }
            case 'parse_response': {
              const validCalls: ParsedToolCall[] = []
              for (const tc of pendingToolCalls) {
                let input: Record<string, unknown>
                try {
                  const parsed: unknown = JSON.parse(tc.arguments || '{}')
                  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    const shape =
                      parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed
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
                  this.renderer.warn(
                    `Warning: malformed tool arguments for ${tc.name} (JSON parse failed, likely truncated).`,
                  )
                  this.eventLog?.append('tool_call', tc.name, {
                    parse_error: true,
                    raw_args: tc.arguments.slice(0, 200),
                  })
                  messages.push({
                    role: 'tool',
                    tool_call_id: tc.id,
                    name: tc.name,
                    content: `Could not parse tool arguments as valid JSON (likely truncated by max_tokens). Raw args (first 200 chars): ${tc.arguments.slice(0, 200)}. Retry with shorter or simpler arguments.`,
                  })
                  continue
                }
                validCalls.push({ tc, input })
              }
              pendingParsedCalls = validCalls
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
              state = transitionQueryState(state, { type: 'booted' })
              break
          }
        }
        if (state.kind === 'complete') {
          result = { stopped: true, reason: state.reason, output: state.output }
        } else {
          result = { stopped: true, reason: 'error', output: finalOutput }
        }
      } catch (err) {
        const errMsg = (err as Error).message || String(err)
        const errorIteration = 'iteration' in state ? state.iteration : 0
        this.config.hookRunner?.runOnError?.(err as Error, {
          turnNumber: errorIteration,
          lastToolName,
        })
        this.renderer.error(`Engine error: ${errMsg}`)
        result = { stopped: true, reason: 'error', output: finalOutput || `[Error: ${errMsg}]` }
      } finally {
        if (this.softAbortRequested && this.softAbortOwner === turnAbortController) {
          this.softAbortRequested = false
          this.softAbortOwner = null
        }
      }
      result = await acceptRunResult({
        config: this.config,
        eventLog: this.eventLog,
        run,
        modules: this.modules,
        messages,
        result,
        verificationPlan,
        startingArtifact,
      })
      return { result, newHistory: settleHistory(messages) }
    } catch (error) {
      try {
        run.store?.finish('needs_recovery')
      } catch (failure) {
        this.renderer.warn('Run state could not be persisted: ' + String(failure))
      }
      const status =
        turnAbortController.signal.aborted &&
        !String(turnAbortController.signal.reason).startsWith('timeout:')
          ? 'cancelled'
          : 'failed'
      return {
        result: {
          stopped: true,
          reason: 'error',
          status,
          runId: run.runId,
          output: String(error),
          verification: {
            status: 'not_run',
            workspace: this.config.cwd,
            commands: [],
            output: 'Initialization failed',
          },
          unfinishedResources: [...run.pending.keys()],
        },
        newHistory: settleHistory(messages),
      }
    } finally {
      quarantineRun(run)
      run.detachParent()
      this.currentTurnAbortController = null
      this.activeRun = null
      this._turnInFlight = false
    }
  }
  getModel(): string {
    return this.config.model
  }
  getModelClient(): OpenAI {
    return this.client
  }
  setModel(model: string): void {
    this.config.model = model
    for (const module of this.modules) module.onModelChange?.(model)
  }
  getCostTracker(): CostTracker {
    return this.costTracker
  }
  getBackgroundTaskManager(): BackgroundTaskManager {
    return this.backgroundTaskManager
  }
  getPermissionManager(): PermissionManager {
    return this.permissionManager
  }
  isPlanMode(): boolean {
    return this.planModeActive || this.permissionManager.getMode() === 'plan'
  }
  getConfig(): EngineConfig {
    return this.config
  }
  exitPlanMode(): void {
    this.planModeActive = false
    if (this.permissionManager.getMode() === 'plan') this.permissionManager.setMode('default')
    this.config.planMode = false
    if (this.activeRun) this.activeRun.policyRevision++
  }
  enterPlanMode(): void {
    this.planModeActive = true
    this.config.planMode = true
    if (this.activeRun) this.activeRun.policyRevision++
  }
  queueSnip(keepRecent: number): void {
    if (!Number.isSafeInteger(keepRecent) || keepRecent < 0)
      throw new Error('keepRecent must be a finite non-negative integer')
    this.pendingSnipCount = keepRecent
  }
  private applySnipToMessages(
    messages: OpenAIMessage[],
    keepRecent: number,
    reason: string | undefined,
  ): {
    removed: number
    tokensFreed: number
  } {
    const total = messages.length
    const kept = trimHistory(messages, keepRecent)
    const removeCount = total - kept.length
    if (removeCount === 0) {
      return { removed: 0, tokensFreed: 0 }
    }
    const tokensBefore = estimateTokens(messages)
    const boundary: OpenAIMessage = {
      role: 'system',
      source: 'runtime',
      content:
        `[snip] ${removeCount} older messages were removed to free context space` +
        (reason ? ` (${reason})` : '') +
        '. Continue working from the current context — earlier details are no longer available.',
    }
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
  getFileHistory(): FileHistory | null {
    return this.fileHistory
  }
}
export type { EngineObserver } from './engine/observer.js'
export { enforceAggregateToolResultBudget, partitionToolCalls }
