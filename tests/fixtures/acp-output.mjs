import { runAcp } from '../../src/cli/acp.ts'
import { createSessionDir } from '../../src/core/sessionManager.ts'

const [cwd, baseURL] = process.argv.slice(2)
const sessionDir = createSessionDir(cwd)
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
const baseline = signals.map(signal => process.listenerCount(signal))
const outputListeners = process.stdout.listenerCount('error')
process.on('message', message => {
  process.send?.({ type: 'delivered' })
  if (message.signal) process.emit(message.signal)
})
process.send?.({ type: 'ready', sessionDir })
let failure
try {
  await runAcp({ config: { cwd, baseURL, apiKey: 'fixture', model: 'fixture', maxIterations: 1, permissionMode: 'auto', enabledModules: [] }, sessionDir })
} catch (error) {
  failure = error.message
} finally {
  process.send?.({ type: 'completed', failure, signalListeners: signals.map((signal, index) => process.listenerCount(signal) - baseline[index]), outputListeners: process.stdout.listenerCount('error') - outputListeners })
  process.disconnect?.()
}
