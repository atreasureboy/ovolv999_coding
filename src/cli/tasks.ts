import { recordBackgroundOutcome } from '../core/backgroundSession.js'
import type { ExecutionEngine } from '../core/engine.js'
import type { OutcomeStatus, VerificationEvidence } from '../core/outcome.js'
import { normalizeOutcome, outcomeExitCode, settleWithin } from '../core/outcome.js'
import { saveSession } from '../core/sessionManager.js'
import type { OpenAIMessage } from '../core/types.js'
import { trimHistoryForNextTurn } from '../ui/historyTrimmer.js'
import type { Renderer } from '../ui/renderer.js'
import { runWithDeadline } from '../ui/turnDeadline.js'
import { updateProgressLog } from './progress.js'
export const HARD_TURN_DEADLINE_MS = 10 * 60 * 1000
export async function runSingleTask(
  engine: ExecutionEngine,
  renderer: Renderer,
  task: string,
  cwd: string,
  historyRef: OpenAIMessage[],
  sessionDir: string | undefined,
  resumedHistory?: OpenAIMessage[],
  options: {
    deadlineMs?: number
    finalizationMs?: number
  } = {},
): Promise<OutcomeStatus> {
  renderer.humanPrompt(task)
  updateProgressLog(cwd, 'running', task.slice(0, 100))
  const startMs = Date.now()
  let status: OutcomeStatus
  let verification: VerificationEvidence | undefined
  let deadlineExceeded = false
  const finalizationMs = options.finalizationMs ?? 3000
  const saveHistory = (messages: OpenAIMessage[] | undefined): void => {
    if (Array.isArray(messages)) {
      const trimmed = trimHistoryForNextTurn(messages)
      historyRef.length = 0
      historyRef.push(...trimmed)
    }
    if (sessionDir && historyRef.length) {
      try {
        saveSession(sessionDir, historyRef)
      } catch (error) {
        renderer.warn('Could not persist session: ' + (error as Error).message)
      }
    }
  }
  const dl = runWithDeadline(() => engine.runTurn(task, resumedHistory ?? historyRef), {
    deadlineMs: options.deadlineMs ?? HARD_TURN_DEADLINE_MS,
    onDeadline: () => {
      deadlineExceeded = true
      engine.abort()
    },
  })
  try {
    const out = await dl.promise
    status = normalizeOutcome(out.result)
    verification = out.result.verification
    saveHistory(out.newHistory)
  } catch (error) {
    status = deadlineExceeded
      ? 'limit_reached'
      : (error as Error).name === 'AbortError'
        ? 'cancelled'
        : 'failed'
    renderer.error((error as Error).message)
    try {
      const settled = await settleWithin(dl.taskSettled, finalizationMs)
      saveHistory(settled.status === 'fulfilled' ? settled.value.newHistory : undefined)
    } catch (finalizationError) {
      status = 'blocked'
      renderer.error((finalizationError as Error).message)
      await settleWithin(
        Promise.resolve().then(() => engine.dispose()),
        finalizationMs,
      ).catch((cleanupError: unknown) => renderer.error((cleanupError as Error).message))
    }
  } finally {
    dl.clear()
  }
  process.exitCode = outcomeExitCode(status)
  recordBackgroundOutcome(status, verification)
  updateProgressLog(
    cwd,
    status,
    status === 'completed' ? 'accepted' : 'Review the retained task history and artifacts',
  )
  renderer.info(status + ' in ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's')
  return status
}
