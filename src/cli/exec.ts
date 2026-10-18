import { AgentService } from '../core/agentService.js'
import { ExecutionEngine } from '../core/engine.js'
import type { EngineObserver } from '../core/engine/observer.js'
import { normalizeOutcome, outcomeExitCode } from '../core/outcome.js'
import type { EngineConfig } from '../core/types.js'
import { readStdin } from '../ui/input.js'
import { ProtocolOutput } from './protocolOutput.js'

const silentObserver: EngineObserver = {
  startSpinner() {}, stopSpinner() {}, beginAssistantText() {}, streamToken() {},
  endAssistantText() {}, toolStart() {}, toolResult() {}, contextWarning() {},
  compactStart() {}, compactDone() {}, warn() {}, error() {},
}

export async function runExec(options: {
  config: EngineConfig
  sessionDir: string
  task: string
  responseSchema?: Record<string, unknown>
  onUserPromptSubmit?: (text: string) => Promise<unknown>
}): Promise<void> {
  const stdin = process.stdin.isTTY ? '' : await readStdin()
  const text = [options.task, stdin].filter(value => value.trim()).join('\n\n')
  if (!text.trim()) throw new Error('exec requires a task or standard input')
  await options.onUserPromptSubmit?.(text)
  const service = new AgentService({ engineFactory: context => new ExecutionEngine({ ...options.config, cwd: context.cwd, sessionDir: context.sessionDir }, silentObserver) })
  let active: { threadId: string; turnId: string } | undefined
  let interrupted = false
  let outputError: Error | undefined
  let outputDeadline: ReturnType<typeof setTimeout> | undefined
  const subscription = new AbortController()
  const stopOutput = (error: Error): void => {
    outputError ??= error
    output.abort(error)
    subscription.abort()
  }
  const interrupt = (): void => {
    interrupted = true
    if (active) void service.interrupt(active.threadId, active.turnId).catch(() => {})
    if (!outputDeadline && !outputError) outputDeadline = setTimeout(() => stopOutput(new Error('Event output did not drain after interruption')), 1000)
  }
  const output = new ProtocolOutput(error => { stopOutput(error); interrupt() })
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  process.on('SIGHUP', interrupt)
  try {
    const { threadId } = await service.register({ sessionDir: options.sessionDir, cwd: options.config.cwd })
    const before = await service.snapshot(threadId)
    active = await service.start({ threadId, cwd: options.config.cwd, text, responseSchema: options.responseSchema })
    if (interrupted) interrupt()
    const completion = service.wait(threadId, active.turnId)
    let completionFailure: unknown
    void completion.catch(error => { completionFailure = error; stopOutput(error instanceof Error ? error : new Error(String(error))) })
    let terminalReceived = false
    try {
      for await (const event of service.subscribe(threadId, before.lastSequence, { signal: subscription.signal })) {
        if (outputError) throw outputError
        await output.write(JSON.stringify(event) + '\n')
        if (event.type === 'turn.finished' && event.turnId === active.turnId) { terminalReceived = true; break }
      }
      if (!terminalReceived) throw outputError ?? (completionFailure instanceof Error ? completionFailure : new Error('Event stream ended without a durable turn result', { cause: completionFailure }))
    } catch (error) {
      interrupt()
      process.stderr.write('Event output stopped: ' + String(error) + '\n')
      stopOutput(error instanceof Error ? error : new Error(String(error)))
    } finally {
      subscription.abort()
    }
    const outcome = await completion
    process.exitCode = outputError ? 1 : outcomeExitCode(normalizeOutcome(outcome.result))
  } finally {
    clearTimeout(outputDeadline)
    subscription.abort()
    process.off('SIGINT', interrupt)
    process.off('SIGTERM', interrupt)
    process.off('SIGHUP', interrupt)
    try { await service.dispose() } finally { await output.close() }
  }
}
