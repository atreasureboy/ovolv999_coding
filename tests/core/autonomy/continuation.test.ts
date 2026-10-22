import { expect, it } from 'vitest'
import { decideContinuation, fingerprintFailure, type LoopObservation } from '../../../src/core/autonomy/continuation.js'
import { sanitizeLoopEvidence } from '../../../src/core/autonomy/context.js'
import type { LoopState } from '../../../src/core/autonomy/types.js'
import type { OutcomeReason, VerificationEvidence } from '../../../src/core/outcome.js'

function state(): LoopState {
  return { schemaVersion: 1, taskId: 'task', workspace: 'workspace', sessionId: 'session', goalHash: 'goal', definitionHash: 'definition', revision: 1, maxIterations: 12, stagnationLimit: 3, consumedIterations: 1, stagnation: { count: 0 } }
}

function evidence(output = 'error TS123 at line 42'): VerificationEvidence {
  return { status: 'failed', workspace: 'workspace', artifactVersion: 'artifact', definitionHash: 'definition', output, commands: [{ command: 'npm test', kind: 'unit', scope: 'workspace', passed: false, exitCode: 1, output }] }
}

function observation(overrides: Partial<LoopObservation> = {}): LoopObservation {
  return { status: 'failed', reason: { code: 'acceptance_failed' }, verification: sanitizeLoopEvidence(evidence(), []), verificationSource: 'loop', artifactVersion: 'artifact', cancelled: false, recoveryRequired: false, pendingApproval: false, steeringPending: false, unfinishedResources: [], ...overrides }
}

it.each([
  [{ cancelled: true }, 'cancelled', undefined],
  [{ status: 'cancelled' }, 'cancelled', undefined],
  [{ status: 'interrupted' }, 'interrupted', undefined],
  [{ status: 'needs_input' }, 'needs_input', undefined],
  [{ status: 'limit_reached' }, 'limit_reached', undefined],
  [{ status: 'blocked' }, 'blocked', undefined],
  [{ recoveryRequired: true }, 'blocked', 'recovery_required'],
  [{ unfinishedResources: ['process:1'] }, 'blocked', 'recovery_required'],
  [{ pendingApproval: true }, 'needs_input', 'approval_required'],
  [{ steeringPending: true }, 'interrupted', 'steering_pending'],
] as const)('stops before acceptance retry for %j', (overrides, status, code) => {
  const result = decideContinuation(state(), observation(overrides))
  expect(result.decision).toMatchObject({ action: 'stop', status, ...(code ? { reason: { code } } : {}) })
  expect(result.stagnation.count).toBe(0)
})

it.each([
  [{ code: 'permission_denied', source: 'approval' }, 'failed'],
  [{ code: 'approval_stale' }, 'blocked'],
  [{ code: 'approval_required' }, 'needs_input'],
  [{ code: 'budget_denied', kind: 'tokens' }, 'limit_reached'],
  [{ code: 'budget_denied', kind: 'pricing' }, 'blocked'],
  [{ code: 'recovery_required', scope: 'operation' }, 'blocked'],
  [{ code: 'turn_deadline' }, 'limit_reached'],
  [{ code: 'steering_pending' }, 'interrupted'],
  [{ code: 'verification_unavailable' }, 'failed'],
  [{ code: 'acceptance_invalidated' }, 'blocked'],
] satisfies Array<[OutcomeReason, string]>)('honors host reason %j from either result or verification', (reason, status) => {
  expect(decideContinuation(state(), observation({ reason })).decision).toMatchObject({ action: 'stop', status, reason })
  const verification = { ...observation().verification, outcomeReason: reason }
  expect(decideContinuation(state(), observation({ verification })).decision).toMatchObject({ action: 'stop', status, reason })
})

it('keeps explicit cancellation and interruption ahead of approval and recovery', () => {
  expect(decideContinuation(state(), observation({ cancelled: true, recoveryRequired: true, pendingApproval: true })).decision).toMatchObject({ status: 'cancelled' })
  expect(decideContinuation(state(), observation({ status: 'interrupted', recoveryRequired: true })).decision).toMatchObject({ status: 'interrupted' })
})

it('stops unknown failures and never retries successful or unverified model text', () => {
  expect(decideContinuation(state(), observation({ reason: undefined })).decision).toMatchObject({ action: 'stop', status: 'failed' })
  expect(decideContinuation(state(), observation({ status: 'completed', reason: undefined })).decision).toMatchObject({ action: 'stop', status: 'blocked' })
})

it('blocks the third unchanged failure, including restored state, ahead of the iteration limit', () => {
  let current = state()
  const actions = []
  for (let index = 0; index < 3; index++) {
    current.consumedIterations = index + 1
    current.maxIterations = 3
    const result = decideContinuation(current, observation())
    actions.push(result.decision.action === 'continue' ? 'continue' : result.decision.status)
    current = JSON.parse(JSON.stringify({ ...current, stagnation: result.stagnation })) as LoopState
  }
  expect(actions).toEqual(['continue', 'continue', 'blocked'])
  expect(current.stagnation.count).toBe(3)
})

it('resets stagnation for meaningful artifact or diagnostic changes and stops remaining-budget exhaustion', () => {
  const current = state()
  current.stagnation = decideContinuation(current, observation()).stagnation
  current.stagnation.count = 2
  expect(decideContinuation(current, observation({ artifactVersion: 'changed', verification: { ...observation().verification, artifactVersion: 'changed' } })).stagnation.count).toBe(1)
  expect(decideContinuation(current, observation({ verification: sanitizeLoopEvidence(evidence('error TS124 at line 43'), []) })).stagnation.count).toBe(1)
  current.consumedIterations = 12
  current.stagnation.count = 0
  expect(decideContinuation(current, observation()).decision).toMatchObject({ action: 'stop', status: 'limit_reached' })
})

it('normalizes only ANSI, line endings, ISO timestamps and labelled process IDs', () => {
  const first = evidence('\u001b[31m2026-10-22T01:02:03.123Z PID: 123 error line 42\u001b[0m\r\n')
  const next = evidence('2026-10-23T05:06:07+08:00 PID: 987 error line 42\n')
  expect(fingerprintFailure(first)).toBe(fingerprintFailure(next))
  expect(fingerprintFailure(next)).not.toBe(fingerprintFailure(evidence('2026-10-23T05:06:07+08:00 PID: 987 error line 43\n')))
  const current = state()
  current.stagnation = { count: 2, fingerprint: fingerprintFailure(first), artifactVersion: 'artifact' }
  expect(decideContinuation(current, observation({ verification: sanitizeLoopEvidence(next, []) })).stagnation.count).toBe(3)
})

it('includes command identity, kind, scope, exit code, order and full diagnostics before truncation', () => {
  const first = evidence('x'.repeat(20000) + 'first')
  const second = evidence('x'.repeat(20000) + 'second')
  const sanitized = sanitizeLoopEvidence(first, [])
  expect(sanitized.commands[0].output).toBe(sanitizeLoopEvidence(second, []).commands[0].output)
  expect(sanitized.failureFingerprint).not.toBe(sanitizeLoopEvidence(second, []).failureFingerprint)
  for (const command of [{ command: 'npm run build' }, { kind: 'lint' as const }, { scope: 'package' }, { exitCode: 2 }]) {
    expect(fingerprintFailure({ ...first, commands: [{ ...first.commands[0], ...command }] })).not.toBe(fingerprintFailure(first))
  }
  const two = { ...first, commands: [first.commands[0], { ...second.commands[0], command: 'other' }] }
  expect(fingerprintFailure(two)).not.toBe(fingerprintFailure({ ...two, commands: [...two.commands].reverse() }))
  expect(fingerprintFailure({ ...first, commands: [] })).toBeUndefined()
})

it('completes only current loop-source acceptance with consistent successful receipts', () => {
  const verification = sanitizeLoopEvidence({ ...evidence('passed'), status: 'passed', sufficientForCompletion: true, commands: [{ command: 'npm test', passed: true, exitCode: 0, output: 'passed' }] }, [])
  const accepted = observation({ status: 'completed', reason: undefined, verification })
  expect(decideContinuation(state(), accepted).decision).toMatchObject({ action: 'stop', status: 'completed' })
  for (const overrides of [
    { verificationSource: 'turn' as const },
    { verification: { ...verification, definitionHash: 'other' } },
    { verification: { ...verification, artifactVersion: 'other' } },
    { verification: { ...verification, workspace: 'other' } },
    { verification: { ...verification, sufficientForCompletion: false } },
    { verification: { ...verification, commands: [] } },
    ...[{ exitCode: 1 }, { exitCode: null }, { passed: false }, { unfinishedResources: ['child'] }].map(command => ({ verification: { ...verification, commands: [{ ...verification.commands[0], ...command }] } })),
  ]) expect(decideContinuation(state(), { ...accepted, ...overrides }).decision).toMatchObject({ action: 'stop', status: 'blocked' })
})

it('treats unfinished verification resources and cancellation as stop facts', () => {
  expect(decideContinuation(state(), observation({ verification: { ...observation().verification, unfinishedResources: ['child'] } })).decision).toMatchObject({ action: 'stop', status: 'blocked' })
  expect(decideContinuation(state(), observation({ verification: { ...observation().verification, commands: [{ ...observation().verification.commands[0], cancelled: true }] } })).decision).toMatchObject({ action: 'stop', status: 'cancelled' })
})
