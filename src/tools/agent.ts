/**
 * AgentTool — spawn a specialized sub-agent to handle a focused subtask.
 *
 * Features:
 *   - AgentConfig-driven (preset name or custom config)
 *   - Verification gate: auto-run tsc/lint after sub-agent completes
 *   - Call chain tracking: prevent infinite recursion + audit depth
 *   - Parallel execution (multiple Agent calls in one response)
 *
 * Each AgentTool instance carries its OWN (factory, parentConfig,
 * parentRenderer) binding. Call depth is derived from
 * `EngineConfig.initialAgentDepth` on the parent config — there's NO
 * mutable counter on the instance, so concurrent siblings dispatched in
 * the same Promise.all batch all observe the SAME depth value, and the
 * global cap (MAX_CALL_DEPTH) holds across nested spawns without any
 * shared mutable state.
 */

import type { Tool, ToolContext, ToolDefinition, ToolResult, EngineConfig, AgentChildEngineFactory } from '../core/types.js'
import type { AgentConfig } from '../core/agentPresets.js'
import { resolveAgentConfig, validateAgentConfig, PRESET_NAMES } from '../core/agentPresets.js'
import { Renderer } from '../ui/renderer.js'
import { tmuxLayout } from '../ui/tmuxLayout.js'
import { appendFileSync } from 'fs'
import { join, resolve } from 'path'
import { createVerificationPlan, captureArtifactVersion, executeVerification } from '../core/verification.js'
import { normalizeOutcome, settleWithin } from '../core/outcome.js'
import type { VerificationEvidence } from '../core/outcome.js'
import { getWorktreeManager } from './worktree.js'
import { randomUUID } from 'crypto'
import { withWorkspaceAccess, workspaceIdentity, isWorkspaceQuarantined, quarantineWorkspace } from '../core/runContext.js'
export { detectVerifyCommands } from '../core/verification.js'
import { str } from '../core/strings.js'
import type { PermissionManager } from '../core/permissionSystem.js'

/** Hard cap on agent call chain depth (across nesting).
 * The depth is threaded through `EngineConfig.initialAgentDepth` so the
 * cap stays global across nested sub-agents without storing it on any
 * shared mutable state. */
const MAX_CALL_DEPTH = 5

const AGENT_EVENT_LOG_FILE = 'agent_events.ndjson'

// ── Verification gate (AgentOS §6 "No Tuple, No Merge") ─────────────────────

export async function runVerification(cwd: string, signal?: AbortSignal): Promise<{ passed: boolean; output: string } | null> {
  const result = await executeVerification({ cwd, signal })
  return result.status === 'not_applicable' ? null : { passed: result.status === 'passed', output: result.output }
}

const workspaceQueues = new Map<string, Promise<void>>()

async function awaitChild<T>(promise: Promise<T>, cwd: string, signal: AbortSignal | undefined, graceMs: number): Promise<T> {
  if (!signal) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: () => void = () => {}
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abort = () => {
          timer = setTimeout(() => {
            quarantineWorkspace(cwd, promise)
            reject(new Error('Cancelled child did not settle; workspace quarantined until completion.'))
          }, graceMs)
        }
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

// ── Prompt helpers ─────────────────────────────────────────────────────────

function normalizeDelegatedPrompt(prompt: string, config: EngineConfig): string {
  let normalized = prompt
  if (config.sessionDir) {
    normalized = normalized
      .replace(/\bSESSION_DIR\b/g, config.sessionDir)
      .replace(/\/SESSION\b/g, config.sessionDir)
  }
  return normalized
}

function appendAgentEvent(config: EngineConfig, event: Record<string, unknown>): void {
  if (!config.sessionDir) return
  const logPath = join(config.sessionDir, AGENT_EVENT_LOG_FILE)
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  }
  try {
    appendFileSync(logPath, JSON.stringify(payload) + '\n', 'utf8')
  } catch {
    // best-effort audit logging; never break execution on log failure
  }
}

// ── PermissionManager clone helper ──────────────────────────────────────────

/**
 * Make an independent copy of a PermissionManager so the child engine's
 * permission rules and mode never bleed back into (or get clobbered by)
 * the parent. Wrapped as a small helper to keep the call-site readable
 * and to centralize the "no shared mutable references" invariant.
 *
 * Delegates to PermissionManager.clone() — the helper is here so the
 * agent-tool file's import of PermissionManager is value-typed (not
 * type-only) in one localized spot, and to keep the call-site readable
 * when the clone must precede a child config snapshot.
 */
function clonePermissionManager(mgr: PermissionManager): PermissionManager {
  return mgr.clone()
}

// ── AgentTool ────────────────────────────────────────────────────────────────

/**
 * Wire-up for one AgentTool instance. ALL fields are required when wiring
 * IS supplied: there is no module-level fallback for the factory /
 * parentConfig / parentRenderer, and no fallback for the depth counter.
 * The constructor parameter itself is OPTIONAL so `createTools` can build
 * an AgentTool that returns "not initialized" at action time when no
 * wiring is provided; the runtime guard in `execute()` fires in that case.
 */
export interface AgentToolWiring {
  factory: AgentChildEngineFactory
  parentConfig: EngineConfig
  parentRenderer: unknown
}

export class AgentTool implements Tool {
  name = 'Agent'
  metadata = { concurrencySafe: false, mutatesState: true, longRunning: true }

  /** Immutable per-instance wiring — captured once in the constructor and
   * shared by every parallel Agent call dispatched from this tool. May
   * be undefined only when the caller bypasses the type system (e.g.
   * tests using `as any`). `execute()` guards against the runtime
   * misshape and returns "not initialized" instead of dereferencing
   * these fields. */
  private readonly factory: AgentChildEngineFactory | undefined
  private readonly parentConfig: EngineConfig | undefined
  private readonly parentRenderer: unknown

  constructor(wiring?: AgentToolWiring) {
    this.factory = wiring?.factory
    this.parentConfig = wiring?.parentConfig
    this.parentRenderer = wiring?.parentRenderer
  }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'Agent',
      description: `Spawn a specialized sub-agent for a focused task. Calls sharing a workspace execute serially; pass a worktree name to bind a child to an isolated workspace.

## Agent Configuration

Option 1 — Preset name: subagent_type: "explore" | "plan" | "code-reviewer" | "general-purpose"
Option 2 — Custom config: agent_config: { identity, modules, tools, maxIterations }

## Verification Gate

Code changes always run the project verification commands. Set verify: true to request checks for analysis tasks too.
Failed or unavailable verification prevents acceptance of code changes.

## Rules
- prompt must be fully self-contained (sub-agent has no parent context)
- Sub-agent cannot call Agent (no recursion, max depth 5)
- Shared workspace tasks are serialized until child execution, verification, and cleanup finish`,
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: 'Task label' },
          prompt: { type: 'string', description: 'Full task instructions (must be self-contained)' },
          subagent_type: { type: 'string', enum: PRESET_NAMES, description: 'Preset name (default: general-purpose)' },
          agent_config: { type: 'object', description: 'Custom config (overrides subagent_type)' },
          max_iterations: { type: 'number', description: 'Max iterations (overrides preset default)' },
          verify: { type: 'boolean', description: 'Request project checks even when no files changed; edits are always verified' },
          worktree: { type: 'string', description: 'Existing managed worktree name for this task workspace' },
        },
        required: ['description', 'prompt'],
      },
    },
  }

  async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    // Runtime guard: every AgentTool instance must be constructed with a
    // complete wiring. The TypeScript type makes this a compile error, but
    // tests / dynamic callers can still bypass it — fail fast with a
    // descriptive "not initialized" error rather than crashing on a
    // downstream undefined access.
    if (!this.factory || !this.parentConfig || !this.parentRenderer) {
      return {
        content: 'Error: AgentTool not initialized. Construct AgentTool with a complete AgentToolWiring (factory, parentConfig, parentRenderer).',
        isError: true,
      }
    }

    const description = str(input.description, 'subtask')
    const prompt      = str(input.prompt, '')
    const verify      = input.verify === true

    if (!prompt.trim()) {
      return { content: 'Error: prompt cannot be empty', isError: true }
    }

    const presetName = str(input.subagent_type, '') || undefined
    const rawConfig = input.agent_config
    const customConfig = rawConfig ? validateAgentConfig(rawConfig) ?? undefined : undefined
    if (rawConfig && !customConfig) {
      return { content: 'Error: agent_config is malformed — need identity.systemPrompt at minimum', isError: true }
    }
    const agentConfig = resolveAgentConfig({
      preset: customConfig ? undefined : presetName,
      config: customConfig,
    })
    const agentLabel = customConfig ? 'custom' : (presetName ?? 'general-purpose')

    if (typeof input.max_iterations === 'number') {
      agentConfig.maxIterations = Math.min(input.max_iterations, 200)
    }

    let taskContext = { ...context, runId: context.runId ?? randomUUID(), runFamilyId: context.runFamilyId ?? this.parentConfig.runFamilyId ?? randomUUID() }
    const worktreeName = typeof input.worktree === 'string' ? input.worktree : undefined
    if (worktreeName) {
      try {
        const binding = getWorktreeManager(context.cwd).getBinding(worktreeName)
        getWorktreeManager(context.cwd).invalidateAcceptance(worktreeName)
        taskContext = { ...taskContext, cwd: binding.cwd, workspace: binding }
      } catch (error) {
        return { content: 'Error binding worktree: ' + (error as Error).message, isError: true, status: 'blocked' }
      }
    }
    const workspace = workspaceIdentity(taskContext.cwd)
    if (isWorkspaceQuarantined(workspace)) return { content: 'Workspace is blocked by unfinished child resources.', isError: true, status: 'blocked' }
    const queueKey = `${workspace}:${this.parentConfig.initialAgentDepth ?? 0}`
    const previous = workspaceQueues.get(queueKey) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveQueue => { release = resolveQueue })
    const queued = previous.then(() => current)
    workspaceQueues.set(queueKey, queued)
    try {
      await previous
      if (taskContext.signal?.aborted) return { content: 'Cancelled before child execution.', isError: true, status: 'cancelled' }
      if (isWorkspaceQuarantined(workspace)) return { content: 'Workspace is blocked by unfinished child resources.', isError: true, status: 'blocked' }
      return await withWorkspaceAccess(taskContext.cwd, taskContext.runFamilyId, true, taskContext.signal ?? new AbortController().signal,
        () => this.runAgentTask(description, prompt, agentConfig, agentLabel, verify, taskContext, worktreeName, context.cwd))
    } catch (error) {
      return { content: (error as Error).message, isError: true, status: taskContext.signal?.aborted ? 'cancelled' : 'failed' }
    } finally {
      release()
      if (workspaceQueues.get(queueKey) === queued) workspaceQueues.delete(queueKey)
    }
  }

  // ── runAgentTask — depth is derived, not mutated ─────────────────────────
  //
  // `inheritedDepth` comes from `parentConfig.initialAgentDepth`, which the
  // parent engine sets when it spawns a child. `nextDepth = inheritedDepth + 1`
  // is computed at the start of each invocation; there is NO instance-level
  // mutable counter, so parallel sibling Agent calls dispatched from the
  // SAME parent config all observe the SAME nextDepth (no shared state to
  // race on). The child's childConfig then carries `initialAgentDepth =
  // nextDepth` so the cap propagates through nested spawns.

  private async runAgentTask(
    description: string,
    prompt: string,
    agentConfig: AgentConfig,
    agentLabel: string,
    verify: boolean,
    context: ToolContext,
    worktreeName?: string,
    repositoryPath?: string,
  ): Promise<ToolResult> {
    // The execute() entry point already validated the wiring is present,
    // so `this.*` are guaranteed defined below.
    const factory = this.factory!
    const parentConfig = this.parentConfig!
    const parentRenderer = this.parentRenderer!

    const inheritedDepth = parentConfig.initialAgentDepth ?? 0
    const nextDepth = inheritedDepth + 1
    if (nextDepth > MAX_CALL_DEPTH) {
      return {
        content: `Max agent call depth (${MAX_CALL_DEPTH}) exceeded — possible recursion. Call chain: ${nextDepth} levels deep.`,
        isError: true,
      }
    }

    const mainRenderer = parentRenderer as {
      agentStart:     (desc: string, type: string) => void
      agentDone:      (desc: string, success: boolean) => void
      agentSummary:   (agentType: string, desc: string, summary: string) => void
      agentHeartbeat: (agentType: string, desc: string, elapsedSec: number) => void
    }
    mainRenderer.agentStart(description, agentLabel)
    const agentStartTime = Date.now()

    // Structured communication event: INVOKE_SENT (with call depth)
    context.eventLog?.append('invoke_sent', agentLabel, {
      description,
      modules: agentConfig.modules ? Object.keys(agentConfig.modules) : [],
      planMode: agentConfig.identity.planMode ?? false,
      maxIterations: agentConfig.maxIterations,
      call_depth: nextDepth,
      verify_enabled: verify,
    }, [agentLabel, 'invoke'])

    const paneLabel = `[${agentLabel}] ${description}`
    const paneSlot = tmuxLayout.acquireSlot(paneLabel)
    const childRenderer = paneSlot
      ? Renderer.forFile(paneSlot.logFile)
      : (parentRenderer as Renderer)
    const runtimePaths = [...(parentConfig.verificationExcludedPaths ?? []), ...(context.verificationExcludedPaths ?? []), ...[parentConfig.sessionDir, context.sessionDir].filter((path): path is string => Boolean(path))]

    const childConfig: EngineConfig = {
      ...parentConfig,
      agent: agentConfig,
      cwd: context.cwd,
      parentRunId: context.runId,
      runFamilyId: context.runFamilyId,
      parentSignal: context.signal,
      workspace: context.workspace,
      hookRunner: undefined,
      sessionDir: undefined,
      verificationExcludedPaths: runtimePaths,
      // Thread depth so the child engine's AgentTool derives the SAME
      // nextDepth = inheritedDepth + 1 = nextDepth + 1 hop later, even
      // though we don't mutate any counter on the parent side.
      initialAgentDepth: nextDepth,
      // ── Isolated PermissionManager for the child engine ────────
      // Spread of `parentConfig` would otherwise hand the child the
      // SAME PermissionManager instance the parent is using — meaning
      // the child's addRule / removeRule / setMode would mutate the
      // parent's permission state, and a parent's mode cycle would
      // silently change what the child auto-approves. Clone via the
      // manager's own `clone()` so rules + mode are decoupled from
      // the parent's instance. Pass `undefined` (not the parent's
      // manager) when no manager is configured — the child engine
      // creates a fresh one from `permissionMode` itself.
      permissionManager: parentConfig.permissionManager
        ? clonePermissionManager(parentConfig.permissionManager)
        : undefined,
    }

    const childEngine = factory(childConfig, childRenderer)

    const normalizedPrompt = normalizeDelegatedPrompt(prompt, parentConfig)
    const placeholdersReplaced = normalizedPrompt !== prompt
    const inheritedContextLines = [
      `- session_dir: ${parentConfig.sessionDir ?? 'not set'}`,
      `- call_depth: ${nextDepth}`,
    ]

    const sessionDirHint = parentConfig.sessionDir
      ? `\n- Session dir: ${parentConfig.sessionDir}`
      : ''
    const delegatedPrompt = [
      '[Delegation Contract]',
      '- Strictly follow the "Task Instructions" below. Do not change task scope.',
      '- If user/main agent gave explicit constraints, treat them as highest priority.',
      '- If information is missing and blocks execution, report what is missing. Do not guess.',
      '- If SESSION_DIR placeholder appears, use the value from "Inherited Context" below.',
      sessionDirHint,
      '',
      '[Inherited Context]',
      ...inheritedContextLines,
      '',
      '[Task Description]',
      description,
      '',
      '[Task Instructions]',
      normalizedPrompt,
    ].join('\n')

    appendAgentEvent(parentConfig, {
      event: 'delegation.start',
      agent_label: agentLabel,
      description,
      max_iterations: agentConfig.maxIterations,
      call_depth: nextDepth,
      verify_enabled: verify,
      placeholders_replaced: placeholdersReplaced,
      prompt_preview: normalizedPrompt.slice(0, 500),
    })

    // ── Lifecycle scaffolding: timer + abort listener, BOTH torn down
    //    in `finally` regardless of how the function exits (success,
    //    error, or pre-aborted early return). Setup is hoisted ABOVE
    //    the pre-aborted check so the timer exists even on the early-
    //    return path — otherwise the `finally` would skip a timer that
    //    was never created, leaving callers to wonder whether the
    //    "no clearInterval" path is intentional or a leak.
    //
    // Heartbeat: `unref()` so a still-active interval does not keep
    // the Node.js event loop alive on process exit. The interval is
    // also cleared in `finally` so we don't leak a callback when the
    // child finishes (success/error/abort). unref() is a Node-specific
    // extension; the optional-chain tolerates non-Node runtimes.
    const HEARTBEAT_MS = 2 * 60 * 1000
    const heartbeatTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - agentStartTime) / 1000)
      mainRenderer.agentHeartbeat(agentLabel, description, elapsedSec)
    }, HEARTBEAT_MS)
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref()

    // Abort listener: store in a named variable so `finally` can
    // remove it. The previous anonymous-arrow pattern meant the
    // listener could never be detached — a long-lived parent signal
    // would retain a reference to `childEngine` forever, defeating
    // the `dispose()` teardown below. `{ once: true }` keeps the
    // fire-and-forget semantics so we don't need to track removal
    // for the "abort already fired" case, but explicit removal is
    // still required on the normal (no-abort) exit path.
    let abortListener: (() => void) | null = null

    let response: ToolResult | undefined
    let verificationExcludedPaths: readonly string[] = []
    try {
      abortListener = () => childEngine.abort()
      context.signal?.addEventListener('abort', abortListener, { once: true })
      if (context.signal?.aborted) {
        response = { content: '[' + agentLabel + '] Cancelled (parent task aborted)', isError: true, status: 'cancelled' }
      } else {
        const plan = createVerificationPlan(context.cwd, undefined, runtimePaths)
        verificationExcludedPaths = plan.excludedPaths
        const before = await captureArtifactVersion(context.cwd, verificationExcludedPaths)
        context.signal?.throwIfAborted()
        const { result } = await awaitChild(childEngine.runTurn(delegatedPrompt, []), context.cwd, context.signal, parentConfig.cancellationGraceMs ?? 2000)
        const artifactVersion = await captureArtifactVersion(context.cwd, verificationExcludedPaths)
        const changed = before !== artifactVersion
        let status = context.signal?.aborted ? 'cancelled' as const : normalizeOutcome(result)
        let verification: VerificationEvidence = result.verification ?? {
          status: 'not_run', workspace: resolve(context.cwd), commands: [], output: '',
        }
        const manager = worktreeName ? getWorktreeManager(repositoryPath!) : undefined
        const artifact = worktreeName ? manager!.getArtifact(worktreeName) : undefined
        if ((changed || verify) && status === 'completed') {
          if (!(verification.status === 'passed' && verification.workspace === plan.workspace
            && verification.artifactVersion === artifactVersion && verification.definitionHash === plan.definitionHash)) {
            verification = await executeVerification({ cwd: context.cwd, plan, signal: context.signal, runId: context.runId, artifactVersion })
          }
          if (context.signal?.aborted) status = 'cancelled'
          else if (verification.status === 'failed') status = 'failed'
          else if (changed && verification.status !== 'passed') status = 'blocked'
        }
        if (status === 'completed' && verification.status === 'passed' && worktreeName && artifact) {
          await manager!.acceptArtifact(worktreeName, verification, artifact)
        }
        const verifySection = verification.output ? '\n\n---\n[Verify Gate] ' + verification.status + '\n' + verification.output : ''
        response = {
          content: '[' + agentLabel + '] "' + description + '" (' + status + '):\n\n' + (result.output || 'No text output.') + verifySection,
          isError: status !== 'completed', status, verification,
        }
        const summary = result.output.split('\n').filter(line => line.trim()).slice(0, 8).join('\n')
        if (summary) mainRenderer.agentSummary(agentLabel, description, summary)
      }
    } catch (error) {
      response = {
        content: '[' + agentLabel + '] "' + description + '" error: ' + (error as Error).message,
        isError: true, status: context.signal?.aborted ? 'cancelled' : 'failed',
      }
    } finally {
      clearInterval(heartbeatTimer)
      const disposal = Promise.resolve().then(() => childEngine.dispose?.())
      try {
        await settleWithin(disposal, 3000)
      } catch (error) {
        quarantineWorkspace(context.cwd, disposal)
        response = { ...response, isError: true, status: 'blocked', content: (response?.content ?? '') + '\nChild cleanup failed: ' + (error as Error).message }
      }
      if (abortListener) context.signal?.removeEventListener('abort', abortListener)
      if (paneSlot) {
        try { tmuxLayout.releaseSlot(paneSlot.slot) } finally { childRenderer.destroy() }
      }
    }
    response ??= { content: 'Child execution did not produce a terminal result.', isError: true, status: 'failed' }
    if (response.verification?.status === 'passed' && response.status === 'completed') {
      try {
        if (response.verification.artifactVersion !== await captureArtifactVersion(context.cwd, verificationExcludedPaths)) {
          response = { ...response, isError: true, status: 'failed', verification: { ...response.verification, status: 'failed', output: `${response.verification.output}\nArtifact changed during child cleanup.` } }
        }
      } catch (error) {
        response = { ...response, isError: true, status: 'blocked', content: `${response.content}\nCannot recheck final artifact: ${(error as Error).message}` }
      }
    }
    if (context.signal?.aborted && response.status === 'completed') {
      response = { ...response, isError: true, status: 'cancelled', content: `${response.content}\nCancelled during child cleanup.` }
    }
    if (response.isError && worktreeName) getWorktreeManager(repositoryPath!).invalidateAcceptance(worktreeName)
    const event = {
      description, success: !response.isError, status: response.status,
      verification: response.verification, duration_ms: Date.now() - agentStartTime,
      call_depth: nextDepth, output_preview: response.content.slice(0, 500),
    }
    mainRenderer.agentDone(description, !response.isError)
    context.eventLog?.append('invoke_completed', agentLabel, event, [agentLabel, 'invoke', response.isError ? 'error' : 'success'])
    appendAgentEvent(parentConfig, { event: 'delegation.completed', agent_label: agentLabel, ...event })
    return response
  }
}
