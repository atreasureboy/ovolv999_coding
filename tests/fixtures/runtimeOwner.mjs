import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { appendFileSync } from 'node:fs'

const [runtime, root, mode] = process.argv.slice(2)
process.env.OVOGO_STATE_DIR = join(root, 'state')
const { withWorkspaceAccess } = await import(pathToFileURL(join(runtime, 'runContext.js')).href)
const { RunStore } = await import(pathToFileURL(join(runtime, 'runStore.js')).href)
process.send('ready')
await new Promise(resolve => process.once('message', resolve))
try {
  await withWorkspaceAccess(root, String(process.pid), true, new AbortController().signal, async () => {
    const store = new RunStore(join(root, 'state'), { runId: 'run-' + process.pid, workspace: root })
    const operation = store.intent('external-effect', false)
    appendFileSync(join(root, 'effects'), 'effect\n')
    process.send({ held: true, store: store.path })
    if (mode === 'hold') await new Promise(resolve => process.once('message', resolve))
    store.receipt(operation, 'completed')
    store.finish('completed')
  })
  process.send('released')
} catch (error) { process.send({ error: error.message }) }
process.disconnect()
