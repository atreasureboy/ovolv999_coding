import type { AgentModule } from '../module.js'
import { normalizeOutcome, type VerificationEvidence } from '../outcome.js'
import { runOperation, withWorkspaceAccess, type RunContext } from '../runContext.js'
import type { EngineConfig, OpenAIMessage, TurnResult } from '../types.js'
import { runHookOperation } from '../hookLifecycle.js'
import {
  captureArtifactVersion,
  executeVerification,
  type VerificationPlan,
} from '../verification.js'
export interface RunAcceptance {
  config: EngineConfig
  eventLog: EngineConfig['eventLog']
  run: RunContext
  modules: AgentModule[]
  messages: OpenAIMessage[]
  result: TurnResult
  verificationPlan: VerificationPlan
  startingArtifact: string
}
export async function acceptRunResult({
  config,
  eventLog,
  run,
  modules,
  messages,
  result,
  verificationPlan,
  startingArtifact,
}: RunAcceptance): Promise<TurnResult> {
  const turnAbortController = run.controller
  let verification: VerificationEvidence = {
    status: 'not_applicable',
    workspace: config.cwd,
    runId: run.runId,
    commands: [],
    output: 'No artifact changes require executable checks',
  }
  let status = normalizeOutcome(result)
  const failures = [...run.toolFailures.values()]
  if (failures.some((failure) => failure.status === 'needs_input')) status = 'needs_input'
  else if (failures.some((failure) => failure.status === 'blocked')) status = 'blocked'
  else if (failures.length && status === 'completed') status = 'failed'
  if (turnAbortController.signal.aborted)
    status = String(turnAbortController.signal.reason).startsWith('timeout:')
      ? 'failed'
      : 'cancelled'
  if (status === 'completed') {
    try {
      const artifact = await runOperation(
        run,
        'artifact:final',
        () =>
          captureArtifactVersion(config.cwd, verificationPlan.excludedPaths, {
            signal: run.controller.signal,
          }),
        60000,
        config.cancellationGraceMs ?? 2000,
      )
      if (artifact !== startingArtifact) {
        verification = await runOperation(
          run,
          'verification',
          () =>
            withWorkspaceAccess(config.cwd, run.familyId, true, turnAbortController.signal, () =>
              executeVerification({
                cwd: config.cwd,
                plan: verificationPlan,
                executionProfile: config.executionProfile,
                signal: turnAbortController.signal,
                runId: run.runId,
                artifactVersion: artifact,
              }),
            ),
          300000,
          config.cancellationGraceMs ?? 2000,
        )
        if (verification.status === 'failed') status = 'failed'
        else if (verification.status !== 'passed' || verification.sufficientForCompletion === false)
          status = 'blocked'
      } else if (run.mutationAttempted) {
        status = 'blocked'
        verification = {
          ...verification,
          status: 'not_run',
          output:
            'A file write produced no change in the artifact inventory. Explicit artifact acceptance is required for ignored outputs or unchanged writes.',
        }
      }
    } catch (error) {
      status =
        turnAbortController.signal.aborted &&
        !String(turnAbortController.signal.reason).startsWith('timeout:')
          ? 'cancelled'
          : 'failed'
      verification = {
        status: 'failed',
        workspace: config.cwd,
        runId: run.runId,
        commands: [],
        output: String(error),
      }
    }
  } else
    verification = {
      ...verification,
      status: 'not_run',
      output: 'Run was not accepted for verification',
    }
  result = {
    ...result,
    status,
    verification,
    runId: run.runId,
    unfinishedResources: [...run.pending.keys()],
  }
  if (status !== 'completed' && result.reason === 'stop_sequence')
    result.reason =
      status === 'interrupted'
        ? 'interrupted'
        : status === 'limit_reached'
          ? 'max_iterations'
          : 'error'
  if (run.pending.size && result.status === 'completed')
    result = {
      ...result,
      status: 'blocked',
      reason: 'error',
      unfinishedResources: [...run.pending.keys()],
    }
  run.result = result
  for (const module of modules) {
    try {
      if (turnAbortController.signal.aborted) break
      await runOperation(
        run,
        'finalize:' + module.name,
        () =>
          Promise.resolve(
            module.onComplete?.({
              cwd: config.cwd,
              sessionDir: config.sessionDir,
              turnResult: result,
              messages,
              eventLog,
              abortSignal: turnAbortController.signal,
              model: config.model,
            }),
          ),
        60000,
        config.cancellationGraceMs ?? 2000,
      )
    } catch (error) {
      void error
    }
  }
  if (turnAbortController.signal.aborted)
    result = {
      ...result,
      reason: 'error',
      status: String(turnAbortController.signal.reason).startsWith('timeout:')
        ? 'failed'
        : 'cancelled',
      unfinishedResources: [...run.pending.keys()],
    }
  if (!turnAbortController.signal.aborted) await runHookOperation(run, config, 'OnComplete', signal =>
    config.hookRunner?.runOnComplete?.(result, signal),
  ).catch(error => { eventLog?.append('tool_result', 'hook:OnComplete', { error: String(error) }) })
  if (turnAbortController.signal.aborted) result = {
    ...result, reason: 'error', status: String(turnAbortController.signal.reason).startsWith('timeout:') ? 'failed' : 'cancelled',
    unfinishedResources: [...run.pending.keys()],
  }
  if (result.status === 'completed') {
    const acceptedArtifact = verification.artifactVersion ?? startingArtifact
    const finalArtifact = await runOperation(
      run,
      'artifact:after-finalization',
      () =>
        captureArtifactVersion(config.cwd, verificationPlan.excludedPaths, {
          signal: run.controller.signal,
        }),
      60000,
      config.cancellationGraceMs ?? 2000,
    )
    if (finalArtifact !== acceptedArtifact) {
      result = {
        ...result,
        reason: 'error',
        status: 'blocked',
        verification: {
          ...verification,
          status: 'failed',
          output: 'Artifact changed during finalization; previous acceptance is stale.',
        },
      }
    }
  }
  if (run.pending.size && result.status === 'completed')
    result = {
      ...result,
      status: 'blocked',
      reason: 'error',
      unfinishedResources: [...run.pending.keys()],
    }
  if (result.status === 'completed')
    run.store?.acceptance(
      verificationPlan.definitionHash,
      verification.artifactVersion ?? startingArtifact,
    )
  run.store?.finish(result.status ?? 'unknown')
  run.result = result
  return result
}
