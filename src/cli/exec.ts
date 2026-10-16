import { spawn, type ChildProcess } from 'node:child_process'
import { AgentService } from '../core/agentService.js'
import { ExecutionEngine } from '../core/engine.js'
import type { EngineObserver } from '../core/engine/observer.js'
import { normalizeOutcome, outcomeExitCode } from '../core/outcome.js'
import type { EngineConfig } from '../core/types.js'
import { readStdin } from '../ui/input.js'

const silentObserver: EngineObserver = {
  startSpinner() {}, stopSpinner() {}, beginAssistantText() {}, streamToken() {},
  endAssistantText() {}, toolStart() {}, toolResult() {}, contextWarning() {},
  compactStart() {}, compactDone() {}, warn() {}, error() {},
}

const outputWriter = `
const fail = error => {
  process.send?.({ error: String(error.message ?? error) });
  process.exitCode = 1;
};
process.stdout.on('error', fail);
process.on('message', text => {
  if (typeof text !== 'string') { fail(new Error('Invalid output frame')); return; }
  process.stdout.write(text, error => {
    if (error) fail(error);
    else process.send?.({ written: true });
  });
});
`

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
  let writer: ChildProcess | undefined
  let writerExited: Promise<void> | undefined
  let writerClosing = false
  let written: ((error?: Error | null) => void) | undefined
  const output = new AbortController()
  const subscription = new AbortController()
  const stopOutput = (error: Error): void => {
    outputError ??= error
    output.abort(error)
    subscription.abort()
    writerClosing = true
    if (writer) writer.kill()
    else process.stdout.unref?.()
  }
  const interrupt = (): void => {
    interrupted = true
    if (active) void service.interrupt(active.threadId, active.turnId).catch(() => {})
    if (!outputDeadline && !output.signal.aborted) outputDeadline = setTimeout(() => stopOutput(new Error('Event output did not drain after interruption')), 1000)
  }
  const onOutputError = (error: Error): void => { stopOutput(error); interrupt() }
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', interrupt)
  process.on('SIGHUP', interrupt)
  process.stdout.on('error', onOutputError)
  try {
    if (process.platform === 'win32' && !process.stdout.isTTY && process.stdout.fd === 1) {
      writer = spawn(process.execPath, ['-e', outputWriter], { windowsHide: true, env: {}, stdio: ['ignore', 1, 'ignore', 'ipc'] })
      writerExited = new Promise(resolve => {
        writer!.once('exit', () => resolve())
        writer!.once('error', () => { if (!writer!.pid) resolve() })
      })
      writer.on('error', onOutputError)
      writer.on('message', message => {
        const event = message as { error?: unknown; written?: unknown }
        if (typeof event.error === 'string') onOutputError(new Error(event.error))
        else if (event.written === true && written) { const finish = written; written = undefined; finish() }
        else onOutputError(new Error('Invalid output writer acknowledgement'))
      })
      writer.once('exit', () => {
        const error = new Error('Event output writer exited')
        written?.(error)
        written = undefined
        if (!writerClosing) onOutputError(error)
      })
    }
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
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: Error | null): void => {
            output.signal.removeEventListener('abort', abort)
            if (error) reject(error)
            else resolve()
          }
          const abort = (): void => finish(output.signal.reason as Error)
          if (output.signal.aborted) { abort(); return }
          output.signal.addEventListener('abort', abort, { once: true })
          try {
            const line = JSON.stringify(event) + '\n'
            if (writer) { written = finish; writer.send(line, error => { if (error) finish(error) }) }
            else process.stdout.write(line, finish)
          } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
        })
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
    try { await service.dispose() } finally {
      writerClosing = true
      if (writer?.connected) writer.disconnect()
      const closeDeadline = writer ? setTimeout(() => writer!.kill(), 1000) : undefined
      try { await writerExited } finally { clearTimeout(closeDeadline); writer?.channel?.unref(); process.stdout.off('error', onOutputError) }
    }
  }
}
