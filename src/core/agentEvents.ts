import type { ApprovalDecision, ApprovalPending, ApprovalRequest } from './approvalBroker.js'
import type { OutcomeStatus, VerificationEvidence } from './outcome.js'
import type { ToolResult, TurnResult } from './types.js'

export type AgentItemKind = 'message' | 'tool' | 'verification'
export type AgentItemStatus = OutcomeStatus | 'partial'

export interface AgentItemFields {
  itemId: string
  kind: AgentItemKind
  role?: 'user' | 'assistant'
  name?: string
  toolCallId?: string
  inputDigest?: string
  preview?: string
  workspace?: string
  expectedTurnId?: string
}

interface AgentEventCommon {
  schemaVersion: 1
  sequence: number
  threadId: string
  turnId: string
}

type AgentEventPayload =
  | { type: 'turn.started'; runId: string; cwd: string; historyRevision: number }
  | ({ type: 'item.started' } & AgentItemFields)
  | { type: 'item.delta'; itemId: string; text: string; channel?: 'text' | 'reasoning' }
  | ({ type: 'item.completed'; status: AgentItemStatus; result: ToolResult | string; verification?: VerificationEvidence; truncated?: boolean; artifact?: string } & AgentItemFields)
  | { type: 'turn.finished'; status: OutcomeStatus; result: TurnResult; historyRevision: number; truncated?: boolean; artifact?: string }
  | { type: 'approval.requested'; request: Omit<ApprovalRequest, 'signal'> }
  | { type: 'approval.resolved'; decision: ApprovalDecision }
  | { type: 'error'; code: string; message: string }

export type AgentEvent = AgentEventCommon & AgentEventPayload
export type AgentEventInput = AgentEventPayload & { turnId: string }
export type EngineEventInput = AgentEventInput

export interface EngineEventSink {
  emit(event: AgentEventInput): void
}

export interface AgentTurnSnapshot {
  turnId: string
  runId: string
  cwd: string
  historyRevision: number
  status: 'running' | OutcomeStatus
  startedSequence: number
  finishedSequence?: number
  result?: TurnResult
  truncated?: boolean
  artifact?: string
}

export interface AgentItemSnapshot extends AgentItemFields {
  turnId: string
  startedSequence: number
  completedSequence?: number
  status: 'running' | AgentItemStatus
  text: string
  reasoning?: string
  result?: ToolResult | string
  verification?: VerificationEvidence
  truncated?: boolean
  artifact?: string
}

export interface AgentThreadSnapshot {
  schemaVersion: 1
  threadId: string
  cwd: string
  historyRevision: number
  lastSequence: number
  firstAvailableSequence: number
  activeTurn: AgentTurnSnapshot | null
  lastTurn: AgentTurnSnapshot | null
  items: AgentItemSnapshot[]
  pendingApprovals: ApprovalPending[]
  recovery: 'clean' | 'interrupted' | 'recovery_required'
}
