import { createHash } from 'node:crypto'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSessionClient } from '../agentSessionClient.js'
import type { AgentThreadSnapshot } from '../agentEvents.js'
import { createLoopArtifactPolicy } from '../artifactPolicy.js'
import { getBudgetPath } from '../budget.js'
import { runtimeStateRoot } from '../runtimeState.js'
import { inspectRuntime } from '../runtimeRecovery.js'
import { withWorkspaceAccess } from '../runContext.js'
import { OutcomeError, normalizeOutcome, selectOutcomeReason, type VerificationEvidence } from '../outcome.js'
import { captureArtifactVersion, createVerificationPlan, detectVerifyCommands, executeVerification, type VerificationPlan } from '../verification.js'
import type { TurnResult } from '../types.js'
import { buildLoopContext, sanitizeLoopEvidence } from './context.js'
import { decideContinuation, type LoopObservation } from './continuation.js'
import type { LoopAttemptStore } from './attemptStore.js'
import type { LoopCheckpoint, LoopState } from './types.js'

export function readLoopNote(path: string): string {
  try { return readFileSync(path, 'utf8') } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error }
}

export function readStagnationLimit(loopDir: string): number {
  const path = join(loopDir, 'config.json')
  if (!existsSync(path)) return 3
  const fd = openSync(path, 'r')
  const buffer = Buffer.alloc(64 * 1024 + 1)
  let count = 0
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Loop config.json must be a file')
    for (;;) {
      const read = readSync(fd, buffer, count, buffer.length - count, count)
      count += read
      if (count > 64 * 1024) throw new Error('Loop config.json exceeds 64 KiB')
      if (!read) break
    }
  } finally { closeSync(fd) }
  const bytes = buffer.subarray(0, count)
  const config: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some(key => key !== 'stagnationLimit')) throw new Error('Loop config.json only supports stagnationLimit')
  const limit = Object.hasOwn(config, 'stagnationLimit') ? (config as { stagnationLimit: unknown }).stagnationLimit : 3
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) throw new Error('Loop stagnationLimit must be a positive safe integer')
  return limit
}

export class FrozenLoop {
  readonly goal: string
  readonly acceptance: string
  readonly goalHash: string
  readonly plan: VerificationPlan
  private readonly knownSecrets = new Set<string>()

  get secrets(): readonly string[] {
    this.knownSecrets.add(this.client.engine.getConfig().apiKey)
    return [...this.knownSecrets]
  }

  constructor(readonly client: AgentSessionClient, readonly cwd: string, readonly loopDir: string) {
    this.goal = readLoopNote(join(loopDir, 'GOAL.md'))
    this.acceptance = readLoopNote(join(loopDir, 'ACCEPTANCE.md'))
    const commands = this.acceptance.split('\n').flatMap(line => {
      const match = line.match(/^\s*-\s*\[.\]\s*A\d+:\s*.*?`([^`]+)`/)
      return match ? [match[1]] : []
    })
    if (!this.goal.trim() || !commands.length) throw new OutcomeError('Loop requires a goal and executable acceptance checks', { code: 'verification_unavailable' })
    const config = client.engine.getConfig()
    const policy = createLoopArtifactPolicy({ workspace: cwd, loopDir, sessionDir: client.sessionDir, budgetPath: getBudgetPath(config.budgetRoot ?? cwd), runtimeRoot: runtimeStateRoot(), usageRoot: config.usageLedger?.getRoot(), eventLogPath: config.eventLog?.getFilePath() })
    config.artifactPolicy = policy
    this.plan = createVerificationPlan(cwd, [...commands, ...detectVerifyCommands(cwd)], [], undefined, policy)
    config.frozenVerificationPlan = this.plan
    this.goalHash = createHash('sha256').update(this.goal).update(this.acceptance).digest('hex')
    this.knownSecrets.add(config.apiKey)
  }

  matches(): boolean {
    return readLoopNote(join(this.loopDir, 'GOAL.md')) === this.goal && readLoopNote(join(this.loopDir, 'ACCEPTANCE.md')) === this.acceptance
      && createVerificationPlan(this.cwd, this.plan.commands, [], this.plan.checks, this.plan.artifactPolicy).definitionHash === this.plan.definitionHash
  }

  capture(signal?: AbortSignal): Promise<string> {
    return captureArtifactVersion(this.cwd, this.plan.excludedPaths, { signal, artifactPolicy: this.plan.artifactPolicy })
  }

  async guarded<T>(state: LoopState, signal: AbortSignal, operation: (assertOwned: () => void) => Promise<T>): Promise<T> {
    return withWorkspaceAccess(this.cwd, state.taskId, true, signal, async assertOwned => {
      const runtime = await inspectRuntime(this.cwd)
      if (runtime.pendingOperationCount !== 0 || runtime.corruptRecordCount !== 0) throw new OutcomeError('Unresolved workspace operations require recovery', { code: 'recovery_required', scope: 'operation' })
      assertOwned()
      return operation(assertOwned)
    })
  }

  async context(store: LoopAttemptStore, signal: AbortSignal): Promise<ReturnType<typeof buildLoopContext>> {
    const state = store.snapshot()
    const checkpoint = state.current?.checkpoint ?? state.previousCheckpoint
    const previous = checkpoint ? { reference: checkpoint.evidence, evidence: store.readEvidence(checkpoint.evidence) } : undefined
    const version = await this.guarded(state, signal, () => this.capture(signal))
    return buildLoopContext({ state, goal: this.goal, acceptance: this.acceptance, stateNote: readLoopNote(join(this.loopDir, 'STATE.md')), previous, artifactChanged: checkpoint ? checkpoint.artifactVersion !== version : false, knownSecrets: this.secrets })
  }

  async checkpoint(store: LoopAttemptStore, snapshot: AgentThreadSnapshot, result: TurnResult, signal?: AbortSignal, revalidate = false): Promise<{ state: LoopState; verification: VerificationEvidence }> {
    const state = store.snapshot()
    const localSignal = signal?.aborted ? AbortSignal.timeout(3000) : signal ?? new AbortController().signal
    return this.guarded(state, localSignal, async assertOwned => {
      let artifactVersion = await this.capture(localSignal)
      let source: 'turn' | 'loop' = 'turn'
      let evidence: VerificationEvidence = { ...(result.verification ?? { status: 'not_run', commands: [], output: result.output }), workspace: state.workspace, definitionHash: state.definitionHash, artifactVersion, runId: state.taskId }
      const status = normalizeOutcome(result)
      const reason = selectOutcomeReason(result.outcomeReason, result.verification?.outcomeReason)
      const observation = (): LoopObservation => ({ status: source === 'loop' && status === 'completed' ? evidence.status === 'passed' ? 'completed' : 'failed' : status, reason: selectOutcomeReason(reason, evidence.outcomeReason),
        verification: sanitizeLoopEvidence(evidence, this.secrets), verificationSource: source, artifactVersion,
        cancelled: Boolean(signal?.aborted) || status === 'cancelled', recoveryRequired: snapshot.recovery !== 'clean', pendingApproval: snapshot.pendingApprovals.length > 0,
        steeringPending: reason?.code === 'steering_pending', unfinishedResources: result.unfinishedResources ?? [],
      })
      const invalid = (): void => { evidence = { ...evidence, status: 'failed', outcomeReason: { code: 'acceptance_invalidated' }, sufficientForCompletion: false, output: 'Frozen goal, acceptance definition or artifact changed; review before creating a new task.' }; source = 'loop' }
      if (!this.matches()) invalid()
      else if (!signal?.aborted && status === 'completed' && !reason && snapshot.recovery === 'clean' && !snapshot.pendingApprovals.length && !result.unfinishedResources?.length) {
        source = 'loop'
        const config = this.client.engine.getConfig()
        evidence = await executeVerification({ cwd: this.cwd, plan: this.plan, signal, runId: state.taskId, artifactVersion, executionProfile: config.executionProfile, executionPolicy: config.executionPolicy })
      }
      const currentVersion = await this.capture(localSignal)
      if (!this.matches() || currentVersion !== artifactVersion) { artifactVersion = currentVersion; evidence = { ...evidence, artifactVersion }; invalid() }
      let observed = observation()
      let continuation = decideContinuation(state, observed)
      const guard = (): void => { assertOwned(); store.assertOwned() }
      guard()
      const reference = store.writeEvidence(state.current!.id, observed.verification)
      let checkpoint: LoopCheckpoint = { artifactVersion, evidence: reference, verificationSource: source, ...continuation,
        ...(continuation.decision.action === 'stop' && continuation.decision.status === 'completed' ? { acceptedAt: new Date().toISOString() } : {}),
      }
      const finalVersion = await this.capture(localSignal)
      if (!this.matches() || finalVersion !== artifactVersion) {
        artifactVersion = finalVersion; evidence = { ...evidence, artifactVersion }; invalid()
        observed = observation(); continuation = decideContinuation(state, observed)
        guard()
        checkpoint = { artifactVersion, evidence: store.writeEvidence(state.current!.id, observed.verification), verificationSource: source, ...continuation }
      }
      const decision = checkpoint.decision
      const compatibility = { runId: state.taskId, taskId: state.taskId, checkpointRevision: state.revision + 1, goalHash: state.goalHash, artifactVersion, definitionHash: state.definitionHash, iteration: state.consumedIterations }
      if (checkpoint.acceptedAt) {
        guard()
        writeFileSync(join(this.loopDir, 'DONE.flag'), JSON.stringify({ ...compatibility, acceptedAt: checkpoint.acceptedAt }, null, 2))
      }
      guard()
      writeFileSync(join(this.loopDir, 'OUTCOME.json'), JSON.stringify({ ...compatibility, status: decision.action === 'stop' ? decision.status : 'failed', iterations: state.consumedIterations, verification: observed.verification, ...(decision.action === 'stop' ? { outcomeReason: decision.reason, detail: decision.detail } : {}) }, null, 2))
      guard()
      const versionsMatch = this.matches() && await this.capture(localSignal) === artifactVersion
      if (!versionsMatch && (decision.action === 'continue' || checkpoint.acceptedAt)) throw new OutcomeError('Artifact or definition changed before authoritative checkpoint publication', { code: 'acceptance_invalidated' })
      guard()
      const committed = revalidate ? store.revalidate(state.revision, checkpoint, assertOwned) : store.checkpoint(state.current!.id, state.revision, checkpoint, assertOwned)
      return { state: committed, verification: observed.verification }
    })
  }
}

export function assertLoopSession(state: LoopState, snapshot: AgentThreadSnapshot): void {
  const terminal = state.current?.terminal
  if (snapshot.threadId !== state.sessionId || snapshot.activeTurn || snapshot.pendingApprovals.length || snapshot.recovery !== 'clean'
    || terminal && (snapshot.lastTurn?.turnId !== terminal.turnId || snapshot.lastTurn.finishedSequence !== terminal.finishedSequence || snapshot.lastTurn.historyRevision !== terminal.historyRevision || snapshot.historyRevision !== terminal.historyRevision || terminal.threadId !== snapshot.threadId)) {
    throw new OutcomeError('Service snapshot does not match the complete Loop checkpoint', { code: 'recovery_required', scope: 'session' })
  }
}
