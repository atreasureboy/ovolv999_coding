import { createHash } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import { outcomeReasonStatus, selectOutcomeReason, type OutcomeReason, type OutcomeStatus, type VerificationEvidence } from '../outcome.js'
import type { LoopDecision, LoopEvidence, LoopStagnation, LoopState } from './types.js'

export type LoopObservation = {
  status: OutcomeStatus
  reason?: OutcomeReason
  verification: LoopEvidence
  verificationSource: 'turn' | 'loop'
  artifactVersion: string
  cancelled: boolean
  recoveryRequired: boolean
  pendingApproval: boolean
  steeringPending: boolean
  unfinishedResources: readonly string[]
}

function normalizeDiagnostic(value: string): string {
  return stripVTControlCharacters(value).replace(/\r\n?/g, '\n')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})\b/g, '<timestamp>')
    .replace(/\b(pid\s*[:=]\s*|pid\s+)\d+\b/gi, '$1<pid>')
}

export function fingerprintFailure(evidence: VerificationEvidence): string | undefined {
  const failures = evidence.commands.filter(command => !command.passed || command.exitCode !== 0 || command.cancelled || command.timedOut)
  if (!failures.length) return undefined
  return createHash('sha256').update(JSON.stringify(failures.map(command => ({
    command: stripVTControlCharacters(command.command).replace(/\r\n?/g, '\n'),
    kind: command.kind ?? null,
    scope: command.scope ?? null,
    exitCode: command.exitCode,
    output: normalizeDiagnostic(command.output),
  })))).digest('hex')
}

export function decideContinuation(state: LoopState, observation: LoopObservation): { decision: LoopDecision; stagnation: LoopStagnation } {
  const verification = observation.verification
  const stop = (status: OutcomeStatus, detail: string, reason?: OutcomeReason, stagnation = { ...state.stagnation }) => ({
    decision: { action: 'stop' as const, status, ...(reason ? { reason } : {}), detail }, stagnation,
  })
  if (observation.cancelled || observation.status === 'cancelled' || verification.commands.some(command => command.cancelled)) return stop('cancelled', 'Loop execution was cancelled')
  if (observation.status === 'interrupted') return stop('interrupted', 'Loop execution was interrupted')
  const recovery = observation.recoveryRequired || observation.unfinishedResources.length || verification.unfinishedResources?.length || verification.commands.some(command => command.unfinishedResources?.length)
  const reason = selectOutcomeReason(
    observation.reason?.code === 'acceptance_failed' ? undefined : observation.reason,
    verification.outcomeReason?.code === 'acceptance_failed' ? undefined : verification.outcomeReason,
    recovery ? { code: 'recovery_required', scope: observation.recoveryRequired ? 'session' : 'resources' } : undefined,
    observation.pendingApproval ? { code: 'approval_required' } : undefined,
    observation.steeringPending ? { code: 'steering_pending' } : undefined,
  ) ?? (observation.reason?.code === 'acceptance_failed' || verification.outcomeReason?.code === 'acceptance_failed' ? { code: 'acceptance_failed' as const } : undefined)
  if (reason && reason.code !== 'acceptance_failed') return stop(outcomeReasonStatus(reason), `Loop stopped: ${reason.code}`, reason)
  if (['needs_input', 'blocked', 'limit_reached'].includes(observation.status)) return stop(observation.status, `Loop stopped: ${observation.status}`)
  if (verification.commands.some(command => command.timedOut)) return stop('limit_reached', 'Verification deadline reached', { code: 'turn_deadline' })
  if (observation.status === 'completed' && !reason) {
    const current = observation.verificationSource === 'loop' && verification.workspace === state.workspace && verification.definitionHash === state.definitionHash && verification.artifactVersion === observation.artifactVersion
    const passed = verification.status === 'passed' && verification.sufficientForCompletion === true && verification.commands.length > 0 && verification.commands.every(command => command.passed && command.exitCode === 0)
    if (current && passed) return stop('completed', 'Current independent Loop acceptance passed')
    return stop('blocked', 'Current independent Loop acceptance is missing or invalid', { code: current ? 'verification_unavailable' : 'acceptance_invalidated' })
  }
  if (observation.status !== 'failed' || reason?.code !== 'acceptance_failed') return stop(observation.status === 'completed' ? 'blocked' : observation.status, 'No retryable host acceptance failure')
  const fingerprint = verification.failureFingerprint
  const unchanged = fingerprint !== undefined && state.stagnation.fingerprint === fingerprint && state.stagnation.artifactVersion === observation.artifactVersion
  const stagnation: LoopStagnation = { count: unchanged ? state.stagnation.count + 1 : 1, ...(fingerprint ? { fingerprint } : {}), artifactVersion: observation.artifactVersion }
  if (fingerprint && stagnation.count >= state.stagnationLimit) return stop('blocked', `Unchanged acceptance failure repeated ${stagnation.count} times`, reason, stagnation)
  if (state.consumedIterations >= state.maxIterations) return stop('limit_reached', 'Loop iteration limit reached', undefined, stagnation)
  return { decision: { action: 'continue' }, stagnation }
}
