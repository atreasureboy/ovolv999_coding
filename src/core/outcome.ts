export type OutcomeStatus = 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'limit_reached' | 'blocked' | 'needs_input'

export type VerificationStatus = 'passed' | 'failed' | 'not_run' | 'not_applicable'

export interface VerificationCommandResult {
  command: string
  passed: boolean
  output: string
  exitCode: number | null
  cancelled?: boolean
  timedOut?: boolean
  unfinishedResources?: string[]
}

export interface VerificationEvidence {
  status: VerificationStatus
  workspace: string
  artifactVersion?: string
  definitionHash?: string
  runId?: string
  commands: VerificationCommandResult[]
  output: string
  unfinishedResources?: string[]
}

export function normalizeOutcome(result: { status?: OutcomeStatus; reason: string; output: string; verification?: VerificationEvidence }): OutcomeStatus {
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
