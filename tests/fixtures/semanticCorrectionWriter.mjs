import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [directory, mode, modulePath, oldId] = process.argv.slice(2)
if (mode === 'correction') {
  const rename = fs.renameSync
  fs.renameSync = (...args) => {
    if (!String(args[1]).endsWith('semantic.jsonl')) return rename(...args)
    process.send?.('rewriting')
    const deadline = Date.now() + 8_000
    while (!fs.existsSync(join(directory, 'release-correction'))) {
      if (Date.now() >= deadline) throw new Error('Correction barrier was not released')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return rename(...args)
  }
} else {
  const read = fs.readFileSync
  let reported = false
  fs.readFileSync = (...args) => {
    const result = read(...args)
    if (!reported && String(args[0]).endsWith('ticket')) {
      reported = true
      process.send?.('contended')
    }
    return result
  }
}
syncBuiltinESMExports()
const { SemanticMemory } = await import(modulePath)
const memory = new SemanticMemory(directory)
memory.readAll()
process.send?.('ready')
process.on('message', async () => {
  const result = await memory.writeAsync({
    content: mode === 'append' ? 'Native unrelated fact' : mode === 'correction' ? 'Native corrected convention' : 'Native stale correction',
    tags: ['native'], source: 'user_stated', confidence: 0.8, timestamp: '',
    ...(mode === 'append' ? {} : { supersedes: [oldId], sourceRef: { sessionId: 'native-session', turnId: mode, role: 'user' } }),
  })
  process.send?.({ persistence: result.persistence })
  process.disconnect()
})
