import type { OutcomeReason, OutcomeStatus, VerificationEvidence } from '../outcome.js'
import type { TurnResult } from '../types.js'

export type AttemptPhase = 'prepared' | 'dispatched' | 'settled' | 'checkpointed'
export type LoopDecision = { action: 'continue' } | { action: 'stop'; status: OutcomeStatus; reason?: OutcomeReason; detail: string }
export type LoopEvidence = VerificationEvidence & { failureFingerprint?: string; truncated: boolean }
export type LoopEvidenceRef = { path: string; sha256: string; bytes: number; truncated: boolean }
export type LoopStagnation = { count: number; fingerprint?: string; artifactVersion?: string }
export type LoopTerminal = {
  threadId: string
  turnId: string
  finishedSequence: number
  historyRevision: number
  status: OutcomeStatus
  reason: TurnResult['reason']
  outcomeReason?: OutcomeReason
  unfinishedResources: string[]
}
export type LoopCheckpoint = {
  artifactVersion: string
  evidence: LoopEvidenceRef
  verificationSource: 'turn' | 'loop'
  stagnation: LoopStagnation
  decision: LoopDecision
  acceptedAt?: string
}
export type LoopAttempt = {
  id: string
  ordinal: number
  phase: AttemptPhase
  turn?: { threadId: string; turnId: string }
  terminal?: LoopTerminal
  checkpoint?: LoopCheckpoint
}
export type LoopIdentity = { workspace: string; sessionId: string; goalHash: string; definitionHash: string }
export type LoopState = LoopIdentity & {
  schemaVersion: 1
  taskId: string
  revision: number
  maxIterations: number
  stagnationLimit: number
  consumedIterations: number
  stagnation: LoopStagnation
  current?: LoopAttempt
  previousCheckpoint?: LoopCheckpoint
}
export type LoopAttemptStoreOptions = {
  sessionDir: string
  mode: 'create' | 'resume'
  identity: LoopIdentity
  maxIterations: number
  stagnationLimit: number
  signal?: AbortSignal
}
