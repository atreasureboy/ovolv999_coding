import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { randomUUID, createHash } from 'crypto'
import type { ExecutionEngine } from './engine.js'
import type { Renderer } from '../ui/renderer.js'
import { normalizeOutcome } from './outcome.js'
import type { OutcomeStatus, VerificationEvidence } from './outcome.js'
import { createVerificationPlan, detectVerifyCommands, executeVerification, captureArtifactVersion } from './verification.js'

interface LoopConfig {
  cwd: string
  loopDir: string
  maxIters: number
  signal?: AbortSignal
  sessionDir?: string
}

export interface LoopResult {
  status: OutcomeStatus
  verification: VerificationEvidence
  iterations: number
  runId: string
}

function tryRead(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

function parseAcceptance(content: string): Array<{ id: string; command: string }> {
  return content.split('\n').flatMap(line => {
    const match = line.match(/^\s*-\s*\[.\]\s*(A\d+):\s*.*?`([^`]+)`/)
    return match ? [{ id: match[1], command: match[2] }] : []
  })
}

export async function runLoop(engine: ExecutionEngine, renderer: Renderer, config: LoopConfig): Promise<LoopResult> {
  const { cwd, loopDir, signal } = config
  const runId = randomUUID()
  const maxIters = Number.isSafeInteger(config.maxIters) && config.maxIters > 0 ? config.maxIters : 12
  let verification: VerificationEvidence = { status: 'not_run', workspace: cwd, runId, commands: [], output: '' }
  const finish = (status: OutcomeStatus, iterations: number): LoopResult => {
    const outcome = { status, verification, iterations, runId }
    if (existsSync(loopDir)) writeFileSync(join(loopDir, 'OUTCOME.json'), JSON.stringify(outcome, null, 2))
    return outcome
  }
  if (!existsSync(loopDir)) {
    renderer.error(`Loop configuration directory is missing: ${loopDir}`)
    return finish('blocked', 0)
  }
  const goal = tryRead(join(loopDir, 'GOAL.md'))
  const acceptanceRaw = tryRead(join(loopDir, 'ACCEPTANCE.md'))
  const acceptanceItems = parseAcceptance(acceptanceRaw)
  if (!goal.trim() || !acceptanceItems.length) {
    renderer.error('Loop requires a goal and at least one executable acceptance check.')
    verification = { ...verification, status: 'not_applicable', output: 'No executable acceptance definition.' }
    return finish('blocked', 0)
  }
  const plan = createVerificationPlan(cwd, [...acceptanceItems.map(item => item.command), ...detectVerifyCommands(cwd)], config.sessionDir ? [config.sessionDir] : [])
  const goalHash = createHash('sha256').update(goal).update(acceptanceRaw).digest('hex')
  const abort = (): void => engine.abort()
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (let iter = 1; iter <= maxIters; iter++) {
      if (signal?.aborted) return finish('cancelled', iter - 1)
      if (existsSync(join(loopDir, 'PARKED.flag'))) {
        renderer.warn('PARKED flag detected; task is blocked.')
        return finish('blocked', iter - 1)
      }
      if (tryRead(join(loopDir, 'GOAL.md')) !== goal || tryRead(join(loopDir, 'ACCEPTANCE.md')) !== acceptanceRaw) {
        renderer.error('Frozen goal or acceptance definition changed; restart with reviewed criteria.')
        return finish('blocked', iter - 1)
      }
      renderer.info(`Loop iteration ${iter}/${maxIters}`)
      const prompt = [
        'Execute one iteration toward the frozen goal below.',
        'Read .loop/STATE.md and project conventions, make the required changes, and report their actual status.',
        'Do not modify GOAL.md or ACCEPTANCE.md. DONE.flag is only a request for independent acceptance.',
        'The controller independently executes the frozen acceptance checks and project checks.',
        'If blocked, explain why in STATE.md. Do not claim completion based on a marker or model stop.',
        `Run identity: ${runId}`,
        'STATE.md:', tryRead(join(loopDir, 'STATE.md')),
        'GOAL.md:', goal, 'ACCEPTANCE.md:', acceptanceRaw,
      ].join('\n\n')
      try {
        const { result } = await engine.runTurn(prompt, [])
        const status = signal?.aborted ? 'cancelled' : normalizeOutcome(result)
        if (status !== 'completed') {
          verification = result.verification ?? verification
          renderer.warn(`Iteration ended with status ${status}`)
          if (status !== 'failed' || iter === maxIters) return finish(status, iter)
          continue
        }
      } catch (error) {
        renderer.error(`Iteration failed: ${(error as Error).message}`)
        if (signal?.aborted) return finish('cancelled', iter)
        if (iter === maxIters) return finish('failed', iter)
        continue
      }
      if (tryRead(join(loopDir, 'GOAL.md')) !== goal || tryRead(join(loopDir, 'ACCEPTANCE.md')) !== acceptanceRaw) {
        renderer.error('Frozen goal or acceptance definition changed during execution.')
        return finish('blocked', iter)
      }
      verification = await executeVerification({ cwd, plan, signal, runId, artifactVersion: await captureArtifactVersion(cwd, plan.excludedPaths) })
      renderer.info(verification.output)
      if (signal?.aborted) return finish('cancelled', iter)
      if (verification.status === 'passed') {
        if (tryRead(join(loopDir, 'GOAL.md')) !== goal || tryRead(join(loopDir, 'ACCEPTANCE.md')) !== acceptanceRaw) {
          verification = { ...verification, status: 'failed', output: `${verification.output}\nFrozen goal or acceptance changed during verification.` }
          return finish('blocked', iter)
        }
        writeFileSync(join(loopDir, 'DONE.flag'), JSON.stringify({ runId, goalHash, artifactVersion: verification.artifactVersion, definitionHash: verification.definitionHash, iteration: iter, acceptedAt: new Date().toISOString() }, null, 2))
        renderer.success('Acceptance checks and project checks passed for the current artifact.')
        return finish('completed', iter)
      }
      renderer.warn('Acceptance failed; current artifacts are retained.')
    }
    return finish('limit_reached', maxIters)
  } finally {
    signal?.removeEventListener('abort', abort)
  }
}
