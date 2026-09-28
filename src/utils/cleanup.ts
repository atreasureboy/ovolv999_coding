import { restoreTerminalTitle } from './terminalTitle.js'
import { settleWithin } from '../core/outcome.js'

export interface CleanupOptions {
  onCleanup?: () => void | Promise<void>
  timeoutMs?: number
}

export function registerCleanup(opts: CleanupOptions = {}): () => Promise<void> {
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => {
    if (cleanupPromise) return cleanupPromise
    try { restoreTerminalTitle() } catch (error) { process.stderr.write(`Title restoration failed: ${(error as Error).message}\n`) }
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false) } catch (error) { process.stderr.write(`Terminal restoration failed: ${(error as Error).message}\n`) }
    let operation: Promise<void>
    try { operation = Promise.resolve(opts.onCleanup?.()) } catch (error) { operation = Promise.reject(error instanceof Error ? error : new Error(String(error))) }
    cleanupPromise = settleWithin(operation, opts.timeoutMs ?? 3000).catch((error: unknown) => {
      process.exitCode = 1
      process.stderr.write(`Unfinished cleanup resources: ${(error as Error).message}\n`)
    })
    return cleanupPromise
  }
  const terminate = async (code: number): Promise<void> => {
    process.exitCode = code
    await cleanup()
    process.exit(Number(process.exitCode) || code)
  }
  const signals: NodeJS.Signals[] = ['SIGTERM', 'SIGHUP']
  const handlers = new Map<NodeJS.Signals, () => void>()
  for (const signal of signals) {
    const handler = (): void => { void terminate(130) }
    handlers.set(signal, handler)
    process.on(signal, handler)
  }
  const crashHandler = (): void => { void terminate(1) }
  process.on('uncaughtException', crashHandler)
  process.on('unhandledRejection', crashHandler)
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler)
    process.off('uncaughtException', crashHandler)
    process.off('unhandledRejection', crashHandler)
    return cleanup()
  }
}
