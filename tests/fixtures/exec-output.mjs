import { runExec } from '../../src/cli/exec.ts'
import { AgentService } from '../../src/core/agentService.ts'
import { ExecutionEngine } from '../../src/core/engine.ts'
import { createSessionDir } from '../../src/core/sessionManager.ts'
import { getExecutionHealth } from '../../src/core/executionBackend.ts'
import { getManagedProcessHealth } from '../../src/core/managedProcess.ts'

const [cwd, baseURL, mode] = process.argv.slice(2)
const config = { cwd, baseURL, apiKey: 'fixture', model: 'fixture', maxIterations: 1, permissionMode: 'auto', enabledModules: [] }
const sessionDir = createSessionDir(cwd)
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const baseline = signals.map(signal => process.listenerCount(signal))
const errorBaseline = process.stdout.listenerCount('error')
if (mode === 'callback') Object.defineProperty(process.stdout, 'fd', { value: undefined })
const originalWrite = process.stdout.write
let callback
process.send?.({ type: 'ready', sessionDir })
process.stdout.write = function (...args) {
  if (mode === 'callback' && !callback) {
    callback = args.find(value => typeof value === 'function')
    process.send?.({ type: 'blocked', sessionDir })
    return false
  }
  return originalWrite.apply(this, args)
}
process.on('message', message => {
  process.send?.({ type: 'delivery', writableLength: process.stdout.writableLength })
  if (message.type === 'signal') process.emit(message.signal)
  else if (message.type === 'error') process.stdout.destroy(new Error('fixture output failure'))
  else if (message.type === 'callbackError') callback?.(new Error('fixture callback failure'))
})
try {
  await runExec({ config, sessionDir, task: 'respond with the fixture text' })
  process.stdout.write = originalWrite
  callback?.(new Error('late output callback failure'))
  await new Promise(resolve => setImmediate(resolve))
  const observer = new Proxy({}, { get: () => () => {} })
  const successor = new AgentService({ engineFactory: context => new ExecutionEngine({ ...config, ...context }, observer) })
  const { threadId } = await successor.register({ cwd, sessionDir })
  const snapshot = await successor.snapshot(threadId)
  await successor.dispose()
  await new Promise((resolve, reject) => process.send?.({ type: 'completed', exitCode: process.exitCode ?? 0, sessionDir,
    snapshot: { activeTurn: snapshot.activeTurn, recovery: snapshot.recovery, lastTurn: { status: snapshot.lastTurn?.status } },
    signalListeners: signals.map((signal, index) => process.listenerCount(signal) - baseline[index]),
    outputErrorListeners: process.stdout.listenerCount('error') - errorBaseline,
    execution: getExecutionHealth(), managed: getManagedProcessHealth() }, error => error ? reject(error) : resolve()))
} catch (error) {
  process.stderr.write(String(error.stack ?? error) + '\n')
  process.exitCode = 1
} finally {
  process.stdout.write = originalWrite
  process.disconnect?.()
}
