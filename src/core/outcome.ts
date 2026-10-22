export type OutcomeStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'limit_reached' | 'blocked' | 'needs_input'

export type OutcomeReason =
  | { code: 'permission_denied'; source: 'policy' | 'approval' | 'hook'; requestId?: string }
  | { code: 'approval_required' | 'approval_stale'; requestId?: string }
  | { code: 'budget_denied'; kind: 'requests' | 'tokens' | 'cost' | 'context' | 'pricing' }
  | { code: 'recovery_required'; scope: 'operation' | 'workspace' | 'budget' | 'session' | 'resources' }
  | { code: 'acceptance_failed' | 'acceptance_invalidated' | 'verification_unavailable' | 'turn_deadline' | 'steering_pending' }

export function isOutcomeReason(value: unknown): value is OutcomeReason {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length) return false
  const reason = value as Record<string, unknown>
  let keys: string[]
  switch (reason.code) {
    case 'permission_denied':
      if (typeof reason.source !== 'string' || !['policy', 'approval', 'hook'].includes(reason.source)) return false
      keys = ['code', 'source', 'requestId']
      break
    case 'approval_required': case 'approval_stale': keys = ['code', 'requestId']; break
    case 'budget_denied':
      if (typeof reason.kind !== 'string' || !['requests', 'tokens', 'cost', 'context', 'pricing'].includes(reason.kind)) return false
      keys = ['code', 'kind']
      break
    case 'recovery_required':
      if (typeof reason.scope !== 'string' || !['operation', 'workspace', 'budget', 'session', 'resources'].includes(reason.scope)) return false
      keys = ['code', 'scope']
      break
    case 'acceptance_failed': case 'acceptance_invalidated': case 'verification_unavailable': case 'turn_deadline': case 'steering_pending': keys = ['code']; break
    default: return false
  }
  return Object.keys(reason).every(key => keys.includes(key)) &&
    (!Object.hasOwn(reason, 'requestId') || typeof reason.requestId === 'string' && reason.requestId.length > 0 && reason.requestId.length <= 256)
}

export class OutcomeError extends Error {
  readonly outcomeReason: OutcomeReason
  constructor(message: string, outcomeReason: OutcomeReason, options?: ErrorOptions) {
    super(message, options)
    if (!isOutcomeReason(outcomeReason)) throw new TypeError('Invalid outcome reason')
    this.name = 'OutcomeError'
    this.outcomeReason = { ...outcomeReason }
  }
}

export function outcomeReasonStatus(reason: OutcomeReason): OutcomeStatus {
  switch (reason.code) {
    case 'approval_required': return 'needs_input'
    case 'approval_stale': case 'recovery_required': case 'acceptance_invalidated': return 'blocked'
    case 'budget_denied': return reason.kind === 'pricing' ? 'blocked' : 'limit_reached'
    case 'turn_deadline': return 'limit_reached'
    case 'steering_pending': return 'interrupted'
    default: return 'failed'
  }
}

export function selectOutcomeReason(...reasons: Array<OutcomeReason | undefined>): OutcomeReason | undefined {
  const priority = (reason: OutcomeReason): number => {
    switch (reason.code) {
      case 'recovery_required': return 7
      case 'approval_stale': return 6
      case 'approval_required': return 5
      case 'permission_denied': return 4
      case 'budget_denied': case 'turn_deadline': return 3
      case 'steering_pending': return 2
      default: return 1
    }
  }
  return reasons.reduce<OutcomeReason | undefined>((selected, reason) => reason && (!selected || priority(reason) > priority(selected)) ? reason : selected, undefined)
}

export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'not_applicable'

export interface VerificationCommandResult {
  kind?: 'compile' | 'lint' | 'unit' | 'integration' | 'task_acceptance'
  scope?: string
  command: string
  passed: boolean
  output: string
  exitCode: number | null
  cancelled?: boolean
  timedOut?: boolean
  unfinishedResources?: string[]
}

export interface VerificationEvidence {
  outcomeReason?: OutcomeReason
  sufficientForCompletion?: boolean
  status: VerificationStatus
  workspace: string
  artifactVersion?: string
  definitionHash?: string
  runId?: string
  commands: VerificationCommandResult[]
  output: string
  unfinishedResources?: string[]
}

export function normalizeOutcome(result: { status?: OutcomeStatus; outcomeReason?: OutcomeReason; reason: string; output: string; verification?: VerificationEvidence; unfinishedResources?: string[] }): OutcomeStatus {
  if (result.status === 'cancelled' || result.status === 'interrupted') return result.status
  const reason = selectOutcomeReason(result.outcomeReason, result.verification?.outcomeReason)
  if (reason) return reason.code === 'turn_deadline' && result.unfinishedResources?.length ? 'blocked' : outcomeReasonStatus(reason)
  if (result.status && result.status !== 'completed') return result.status
  if (result.verification?.status === 'failed') return 'failed'
  if (result.reason === 'error') return 'failed'
  if (result.reason === 'interrupted') return 'interrupted'
  if (result.reason === 'cancelled') return 'cancelled'
  if (result.reason === 'max_iterations') return 'limit_reached'
  if (result.status === 'completed') return 'completed'
  if ((result.reason === 'stop_sequence' || result.reason === 'stop') && result.output.trim()) return 'completed'
  return 'blocked'
}

export function outcomeExitCode(status: OutcomeStatus): number {
  if (status === 'completed') return 0
  if (status === 'cancelled' || status === 'interrupted') return 130
  if (status === 'limit_reached') return 124
  if (status === 'blocked' || status === 'needs_input') return 2
  return 1
}

export async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Finalization did not settle within ${timeoutMs}ms; workspace remains unavailable`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
