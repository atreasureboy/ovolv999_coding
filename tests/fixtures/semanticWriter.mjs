import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [directory, mode, modulePath] = process.argv.slice(2)
const rename = fs.renameSync
if (mode.endsWith('rewrite')) {
  fs.renameSync = (...args) => {
    if (!String(args[1]).endsWith('.jsonl')) return rename(...args)
    process.send?.('rewriting')
    const deadline = Date.now() + 5_000
    while (!fs.existsSync(join(directory, 'release-rewrite'))) {
      if (Date.now() >= deadline) throw new Error('Parent did not release the rewrite barrier')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
    }
    return rename(...args)
  }
  syncBuiltinESMExports()
}
if (mode.endsWith('append')) {
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
  syncBuiltinESMExports()
}
const implementation = await import(modulePath)
const episode = mode.startsWith('episode')
const memory = episode ? new implementation.EpisodicMemory(directory, { maxEpisodes: 2 }) : new implementation.SemanticMemory(directory)
memory.readAll()
process.send?.('ready')
process.on('message', async () => {
  if (mode === 'lock') {
    fs.writeFileSync(join(directory, 'memory', 'semantic.jsonl.lock'), JSON.stringify({ pid: process.pid }))
    process.exit(0)
  }
  const result = await memory.writeAsync(episode
    ? { turn: 1, toolName: 'Read', inputSummary: mode, resultSummary: '', outcome: 'success', timestamp: '' }
    : { content: mode === 'rewrite' ? 'shared baseline' : 'other process append', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })
  process.send?.({ persistence: result.persistence })
  process.disconnect()
})
