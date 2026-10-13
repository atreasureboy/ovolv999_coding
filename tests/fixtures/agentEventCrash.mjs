import fs from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

const [dir, runtime, mode] = process.argv.slice(2)
const { AgentEventStore } = await import(pathToFileURL(join(runtime, 'agentEventStore.js')).href)
if (mode === 'manifest-partial') {
  let manifestFd = null
  const originalOpen = fs.openSync
  const originalSync = fs.fsyncSync
  fs.openSync = function (path, ...args) {
    const fd = originalOpen.call(this, path, ...args)
    if (String(path).includes('manifest.json.tmp-')) manifestFd = fd
    return fd
  }
  fs.fsyncSync = function (fd) {
    const result = originalSync.call(this, fd)
    if (fd === manifestFd) {
      process.send('manifest-partial')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
    return result
  }
  syncBuiltinESMExports()
}
const store = new AgentEventStore({ sessionDir: dir, cwd: dir, threadId: 'thread-1', ...(mode === 'retention' ? { maxSegments: 1 } : {}) })
const turnId = 'turn-1'
store.append({ type: 'turn.started', turnId, runId: turnId, cwd: dir, historyRevision: 0 })
if (mode === 'retention') {
  store.append({ type: 'turn.finished', turnId, status: 'completed', result: { stopped: false, reason: 'stop_sequence', output: 'done', status: 'completed', runId: turnId }, historyRevision: 1 })
  store.checkpoint({ historyRevision: 1, turnId })
  const originalUnlink = fs.unlinkSync
  fs.unlinkSync = function (path, ...args) {
    if (String(path).endsWith('.jsonl')) {
      process.send('manifest-committed')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    }
    return originalUnlink.call(this, path, ...args)
  }
  syncBuiltinESMExports()
  store.append({ type: 'turn.started', turnId: 'turn-2', runId: 'turn-2', cwd: dir, historyRevision: 1 })
}
store.append({ type: 'item.started', turnId, itemId: 'message-1', kind: 'message', role: 'assistant' })
store.append({ type: 'item.delta', turnId, itemId: 'message-1', text: 'first' })
store.append({ type: 'item.delta', turnId, itemId: 'message-1', text: 'second' })
if (mode === 'partial') {
  const path = fs.readdirSync(join(dir, 'agent-events')).find(name => name.endsWith('.jsonl'))
  const fd = fs.openSync(join(dir, 'agent-events', path), 'a')
  fs.writeSync(fd, '{"schemaVersion":1,"sequence":5')
  fs.fsyncSync(fd)
  fs.closeSync(fd)
  process.send('partial')
} else process.send('committed')
if (mode === 'sync-failure') {
  let logFd = null
  const originalOpen = fs.openSync
  const originalSync = fs.fsyncSync
  fs.openSync = function (path, ...args) {
    const fd = originalOpen.call(this, path, ...args)
    if (String(path).endsWith('.jsonl')) logFd = fd
    return fd
  }
  fs.fsyncSync = function (fd) {
    if (fd === logFd) throw new Error('Injected event fsync failure')
    return originalSync.call(this, fd)
  }
  syncBuiltinESMExports()
}
process.on('message', message => {
  if (message === 'close') {
    store.close()
    process.send('closed')
  }
  if (message === 'append') {
    try {
      store.append({ type: 'item.delta', turnId, itemId: 'message-1', text: 'later' })
      process.send('appended')
    } catch (error) {
      if (mode === 'sync-failure' && error.message === 'Injected event fsync failure') process.send('fsync-failed')
      else throw error
    }
  }
})
