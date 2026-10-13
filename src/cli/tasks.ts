import { recordBackgroundOutcome } from '../core/backgroundSession.js'
import type { ExecutionEngine } from '../core/engine.js'
import { AgentSessionClient } from '../core/agentSessionClient.js'
import type { OutcomeStatus, VerificationEvidence } from '../core/outcome.js'
import { normalizeOutcome, outcomeExitCode } from '../core/outcome.js'
import type { OpenAIMessage } from '../core/types.js'
import { createAgentEventRenderer } from '../ui/agentEventRenderer.js'
import type { Renderer } from '../ui/renderer.js'
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
    onClient?: (client: AgentSessionClient) => void
    onPromptSubmit?: (signal: AbortSignal) => Promise<unknown>
  } = {},
): Promise<OutcomeStatus> {
  renderer.humanPrompt(task)
  updateProgressLog(cwd, 'running', task.slice(0, 100))
  const startMs = Date.now()
  let status: OutcomeStatus
  let verification: VerificationEvidence | undefined
  const client = new AgentSessionClient({ engine, observer: renderer, cwd, sessionDir, history: resumedHistory ?? historyRef, onEvent: createAgentEventRenderer(renderer), deadlineMs: options.deadlineMs ?? HARD_TURN_DEADLINE_MS, finalizationGraceMs: options.finalizationMs })
  options.onClient?.(client)
  try {
    const out = await client.runTurn(task, undefined, options.onPromptSubmit)
    status = normalizeOutcome(out.result)
    verification = out.result.verification
    historyRef.splice(0, historyRef.length, ...out.newHistory)
  } catch (error) {
    status = (error as Error).name === 'AbortError' ? 'cancelled' : 'failed'
    renderer.error((error as Error).message)
  } finally {
    try { await client.dispose() } catch (error) {
      status = 'blocked'
      renderer.error((error as Error).message)
    }
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
