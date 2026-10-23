import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionClient } from './agentSessionClient.js'
import { AgentServiceError } from './agentService.js'
import type { Renderer } from '../ui/renderer.js'
import { OutcomeError, outcomeReasonStatus, type OutcomeReason, type OutcomeStatus, type VerificationEvidence } from './outcome.js'
import { LoopAttemptStore, LoopIdentityError } from './autonomy/attemptStore.js'
import { FrozenLoop, assertLoopSession, readStagnationLimit } from './autonomy/loopController.js'
import type { LoopState } from './autonomy/types.js'

export interface LoopConfig {
  cwd: string
  loopDir: string
  maxIters: number
  maxItersExplicit?: boolean
  resume?: boolean
  signal?: AbortSignal
  onPromptSubmit?: (text: string, signal: AbortSignal) => unknown
}

export interface LoopResult {
  status: OutcomeStatus
  verification: VerificationEvidence
  iterations: number
  runId: string
  outcomeReason?: OutcomeReason
  detail?: string
}

export async function runLoop(client: AgentSessionClient, renderer: Renderer, config: LoopConfig): Promise<LoopResult> {
  const { cwd, loopDir, signal } = config
  const maxIterations = Number.isSafeInteger(config.maxIters) && config.maxIters > 0 ? config.maxIters : 12
  let store: LoopAttemptStore | undefined
  let restoreEngine: (() => void) | undefined
  let rejectedIdentity: Pick<LoopState, 'taskId' | 'consumedIterations'> | undefined
  let verification: VerificationEvidence = { status: 'not_run', workspace: cwd, commands: [], output: '' }
  const finish = (status: OutcomeStatus, detail: string, outcomeReason?: OutcomeReason): LoopResult => {
    const state = store?.snapshot() ?? rejectedIdentity
    return { status, verification, iterations: state?.consumedIterations ?? 0, runId: state?.taskId ?? '', detail, ...(outcomeReason ? { outcomeReason } : {}) }
  }
  const stopped = (state: LoopState): LoopResult | undefined => {
    const decision = state.current?.checkpoint?.decision
    if (decision?.action === 'stop') return finish(decision.status, decision.detail, decision.reason)
    return undefined
  }
  const interrupt = (): void => { void client.interrupt().catch(() => {}) }
  signal?.addEventListener('abort', interrupt, { once: true })
  let output: LoopResult
  try {
    output = await (async (): Promise<LoopResult> => {
      if (!existsSync(loopDir)) return finish('blocked', 'Loop configuration directory is missing')
      await client.initialize()
      const engineConfig = client.engine.getConfig()
      const originalPolicy = engineConfig.artifactPolicy, originalPlan = engineConfig.frozenVerificationPlan
      restoreEngine = () => { engineConfig.artifactPolicy = originalPolicy; engineConfig.frozenVerificationPlan = originalPlan }
      const stagnationLimit = readStagnationLimit(loopDir)
      let frozen: FrozenLoop
      try { frozen = new FrozenLoop(client, cwd, loopDir) } catch (error) {
        if (error instanceof OutcomeError && error.outcomeReason.code === 'verification_unavailable') verification = { ...verification, status: 'not_applicable', output: error.message }
        throw error
      }
      store = await LoopAttemptStore.open({ sessionDir: client.sessionDir, mode: config.resume ? 'resume' : 'create',
        identity: { workspace: frozen.plan.workspace, sessionId: client.threadId!, goalHash: frozen.goalHash, definitionHash: frozen.plan.definitionHash },
        maxIterations, stagnationLimit, signal,
      })
      let state = store.snapshot()
      if (config.resume && state.current && state.current.phase !== 'checkpointed') return finish('blocked', 'Incomplete submission requires explicit recovery; no attempt was replayed or refunded', { code: 'recovery_required', scope: 'session' })
      if (signal?.aborted) return finish('cancelled', 'Loop execution was cancelled')
      if (existsSync(join(loopDir, 'PARKED.flag'))) return finish('blocked', 'PARKED flag detected')
      if (config.resume) {
        if (stagnationLimit !== state.stagnationLimit) return finish('blocked', 'Loop stagnation threshold conflicts with the saved task', { code: 'recovery_required', scope: 'session' })
        if (maxIterations !== state.maxIterations) {
          if (config.maxItersExplicit) return finish('blocked', 'Explicit iteration limit conflicts with the saved task', { code: 'recovery_required', scope: 'session' })
          renderer.warn(`Using saved Loop iteration limit ${state.maxIterations}; configured default ${maxIterations} was ignored`)
        }
        const snapshot = await client.snapshot()
        assertLoopSession(state, snapshot)
        const checkpoint = state.current?.checkpoint
        if (checkpoint) {
          verification = store.readEvidence(checkpoint.evidence)
          if (checkpoint.decision.action === 'stop' && checkpoint.decision.status === 'completed') {
            const unchanged = await frozen.guarded(state, signal ?? new AbortController().signal, async assertOwned => {
              store!.assertOwned()
              const matches = frozen.matches() && await frozen.capture(signal) === checkpoint.artifactVersion
              assertOwned(); store!.assertOwned()
              return matches
            })
            if (unchanged) return stopped(state)!
            const validated = await frozen.checkpoint(store, snapshot, { stopped: true, reason: 'stop_sequence', status: 'completed', output: '' }, signal, true)
            verification = validated.verification
            state = validated.state
          }
          const terminal = stopped(state)
          if (terminal) return terminal
        }
      }
      for (;;) {
        state = store.snapshot()
        if (signal?.aborted) return finish('cancelled', 'Loop execution was cancelled')
        if (existsSync(join(loopDir, 'PARKED.flag'))) return finish('blocked', 'PARKED flag detected')
        if (!frozen.matches()) return finish('blocked', 'Frozen goal or acceptance changed; create a reviewed task', { code: 'acceptance_invalidated' })
        if (state.consumedIterations >= state.maxIterations) return finish('limit_reached', 'Loop iteration limit reached')
        assertLoopSession(state, await client.snapshot())
        const context = await frozen.context(store, signal ?? new AbortController().signal)
        await client.replaceModelWindow(context.messages)
        if (signal?.aborted) return finish('cancelled', 'Loop execution was cancelled before submission')
        state = store.prepare(store.snapshot().revision)
        const attemptId = state.current!.id
        renderer.info(`Loop iteration ${state.consumedIterations}/${state.maxIterations}`)
        const { result } = await client.runTurn(context.prompt, undefined,
          config.onPromptSubmit ? hookSignal => config.onPromptSubmit!(context.prompt, hookSignal) : undefined,
          { onEvent: event => {
            const current = store!.snapshot()
            if (event.type === 'turn.started') store!.dispatch(attemptId, current.revision, { threadId: event.threadId, turnId: event.turnId })
            if (event.type === 'turn.finished') store!.settle(attemptId, current.revision, {
              threadId: event.threadId, turnId: event.turnId, finishedSequence: event.sequence, historyRevision: event.historyRevision,
              status: event.status, reason: event.result.reason, ...(event.result.outcomeReason ? { outcomeReason: event.result.outcomeReason } : {}),
              unfinishedResources: event.result.unfinishedResources ?? [],
            })
          } },
        )
        const committed = await frozen.checkpoint(store, await client.snapshot(), result, signal)
        verification = committed.verification
        renderer.info(verification.output)
        const terminal = stopped(committed.state)
        if (terminal) {
          if (terminal.status === 'completed') renderer.success('Independent Loop acceptance passed for the current artifact')
          return terminal
        }
      }
    })()
  } catch (error) {
    if (error instanceof LoopIdentityError) rejectedIdentity = { taskId: error.taskId, consumedIterations: error.consumedIterations }
    const reason: OutcomeReason = error instanceof OutcomeError ? error.outcomeReason : { code: 'recovery_required', scope: error instanceof AgentServiceError ? 'session' : 'workspace' }
    const detail = error instanceof Error ? error.message : String(error)
    renderer.error(detail)
    output = finish(signal?.aborted ? 'cancelled' : reason.code === 'verification_unavailable' ? 'blocked' : outcomeReasonStatus(reason), detail, reason)
  } finally {
    signal?.removeEventListener('abort', interrupt)
    restoreEngine?.()
  }
  try { store?.close() } catch (error) { output = finish('blocked', error instanceof Error ? error.message : String(error), { code: 'recovery_required', scope: 'session' }) }
  return output
}
