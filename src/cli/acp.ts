import { AgentSessionClient } from '../core/agentSessionClient.js'
import { ExecutionEngine } from '../core/engine.js'
import type { EngineObserver } from '../core/engine/observer.js'
import type { EngineConfig } from '../core/types.js'
import { settleWithin } from '../core/outcome.js'
import { ACPServer } from '../integrations/acp.js'
import { ACPAgentAdapter } from '../integrations/acp/agentAdapter.js'
import { ProtocolOutput } from './protocolOutput.js'

const silentObserver: EngineObserver = {
  startSpinner() {}, stopSpinner() {}, beginAssistantText() {}, streamToken() {},
  endAssistantText() {}, toolStart() {}, toolResult() {}, contextWarning() {},
  compactStart() {}, compactDone() {}, warn() {}, error() {},
}

export async function runAcp(options: {
  config: EngineConfig
  sessionDir: string
  onUserPromptSubmit?: (text: string, signal?: AbortSignal) => Promise<unknown>
}): Promise<void> {
  let adapter: ACPAgentAdapter | undefined
  let server: ACPServer | undefined
  let outputFailure: Error | undefined
  let closed = false
  let outputDeadline: ReturnType<typeof setTimeout> | undefined
  let end!: () => void
  const disconnected = new Promise<void>(resolve => { end = resolve })
  const boundOutputWait = (): void => {
    outputDeadline ??= setTimeout(() => {
      outputDeadline = undefined
      if (output.pendingBytes) output.abort(new Error('ACP output did not drain after interruption'))
    }, 1000)
  }
  const stop = (): void => { closed = true; server?.stop(); boundOutputWait(); end() }
  const fail = (error: Error): void => { outputFailure ??= error; stop() }
  const interrupt = (): void => { boundOutputWait(); void client.interrupt().catch(fail) }
  const client = new AgentSessionClient({
    engine: new ExecutionEngine(options.config, silentObserver), observer: silentObserver,
    cwd: options.config.cwd, sessionDir: options.sessionDir,
    onEvent: event => {
      if (!adapter) throw new Error('ACP event adapter is not initialized')
      return adapter.publish(event)
    },
  })
  const output = new ProtocolOutput(fail)
  process.on('SIGINT', interrupt)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  process.stdin.on('error', fail)
  try {
    await client.initialize()
    adapter = new ACPAgentAdapter({
      client, onUserPromptSubmit: options.onUserPromptSubmit,
      emit: async event => { server!.notify('agent/event', { event }); await server!.flush() },
    })
    server = new ACPServer({ ...adapter.handlers, onInterrupt: async turnId => {
      const interrupted = await adapter!.handlers.onInterrupt!(turnId)
      if (interrupted !== false) boundOutputWait()
      return interrupted
    } }, {
      cwd: options.config.cwd, capabilities: adapter.capabilities,
      write: text => output.write(text),
    })
    server.on('protocolError', fail)
    server.on('shutdown', stop)
    server.on('close', stop)
    if (!closed) server.start()
    if (process.stdin.readableEnded || process.stdin.destroyed) stop()
    await disconnected
  } finally {
    server?.stop()
    try {
      await client.dispose()
      await adapter?.drain()
      await settleWithin(server?.flush() ?? Promise.resolve(), 3000).catch(error => {
        output.abort(error instanceof Error ? error : new Error(String(error)))
        throw error
      })
    } finally {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', stop)
      process.off('SIGHUP', stop)
      process.stdin.off('error', fail)
      process.stdin.pause()
      clearTimeout(outputDeadline)
      await output.close()
    }
  }
  if (outputFailure) throw outputFailure
}
