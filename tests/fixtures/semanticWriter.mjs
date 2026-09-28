import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'

const [directory, mode, modulePath] = process.argv.slice(2)
const rename = fs.renameSync
if (mode.endsWith('rewrite')) {
  fs.renameSync = (...args) => {
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
  const open = fs.openSync
  let reported = false
  fs.openSync = (...args) => {
    try { return open(...args) }
    catch (error) {
      if (!reported && error.code === 'EEXIST' && String(args[0]).endsWith('.jsonl.lock')) {
        reported = true
        process.send?.('contended')
      }
      throw error
    }
  }
  syncBuiltinESMExports()
}
const implementation = await import(modulePath)
const episode = mode.startsWith('episode')
const memory = episode ? new implementation.EpisodicMemory(directory, { maxEpisodes: 2 }) : new implementation.SemanticMemory(directory)
memory.readAll()
process.send?.('ready')
process.on('message', () => {
  if (mode === 'lock') {
    fs.writeFileSync(join(directory, 'memory', 'semantic.jsonl.lock'), JSON.stringify({ pid: process.pid }))
    process.exit(0)
  }
  const result = memory.write(episode
    ? { turn: 1, toolName: 'Read', inputSummary: mode, resultSummary: '', outcome: 'success', timestamp: '' }
    : { content: mode === 'rewrite' ? 'shared baseline' : 'other process append', tags: [], source: 'user_stated', confidence: 0.9, timestamp: '' })
  process.send?.({ persistence: result.persistence })
  process.disconnect()
})
