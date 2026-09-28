import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [mode, dir, value, runtime] = process.argv.slice(2)
const session = await import(pathToFileURL(join(runtime, 'sessionManager.js')).href)
const locks = await import(pathToFileURL(join(runtime, 'persistenceLock.js')).href)
const wait = () => new Promise(resolve => process.once('message', resolve))
if (mode === 'crashPhase') {
  const pause = phase => {
    if (phase !== value) return
    process.send(phase)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
  }
  const mkdir = fs.mkdirSync
  fs.mkdirSync = function (path, ...args) {
    const result = mkdir.call(this, path, ...args)
    if (String(path).includes('.lock.owners') && !String(path).endsWith('.lock.owners')) pause('owner-published')
    return result
  }
  const open = fs.openSync
  fs.openSync = function (path, ...args) {
    const fd = open.call(this, path, ...args)
    if (String(path).endsWith('ticket.tmp')) pause('ticket-opened')
    return fd
  }
  const sync = fs.fsyncSync
  fs.fsyncSync = function (...args) { const result = sync.apply(this, args); pause('ticket-synced'); return result }
  const rename = fs.renameSync
  fs.renameSync = function (from, to) { const result = rename.call(this, from, to); if (String(to).endsWith('ticket')) pause('ticket-published'); return result }
  const unlink = fs.unlinkSync
  fs.unlinkSync = function (path) { const result = unlink.call(this, path); if (String(path).endsWith('ticket')) pause('release-started'); return result }
  syncBuiltinESMExports()
}
process.send('ready')
await wait()
try {
  if (mode === 'create') {
    process.send(Array.from({ length: Number(value) }, () => session.createSessionDir(dir, new Date('2026-09-28T00:00:00.000Z'))))
  } else if (mode === 'save') {
    session.saveSession(dir, [{ role: 'user', content: value }])
    process.send('saved')
    await wait()
  } else if (mode === 'legacyRecovery') {
    const original = fs.openSync
    fs.openSync = function (path, ...args) {
      const fd = original.call(this, path, ...args)
      if (String(path).endsWith('.lock.recovery')) {
        process.send('recovering')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
      }
      return fd
    }
    syncBuiltinESMExports()
    locks.withPersistenceLock(join(dir, 'state'), () => process.send('acquired'))
  } else if (mode === 'legacyOwner') {
    locks.withPersistenceLock(join(dir, 'state'), () => {
      process.send('held')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
    })
  } else if (mode === 'lease') {
    const lease = await locks.acquirePersistenceLease(join(dir, 'state'), { timeoutMs: 10000 })
    process.send('held')
    await wait()
    lease.assertOwned()
    lease.release()
  } else if (mode === 'resume') {
    session.claimSessionOwnership(dir)
    process.send('claimed')
    await wait()
  } else if (mode === 'staleWriter') {
    session.loadSession(dir)
    process.send('loaded')
    await wait()
    session.saveSession(dir, [{ role: 'user', content: 'stale' }])
    process.send('saved')
  } else if (mode === 'crashPhase') {
    const lease = await locks.acquirePersistenceLease(join(dir, 'state'))
    if (value === 'before-commit') { process.send(value); await wait() }
    fs.writeFileSync(join(dir, 'committed'), 'receipt')
    if (value === 'after-commit') { process.send(value); await wait() }
    lease.release()
  } else if (mode === 'increment') {
    for (let i = 0; i < Number(value); i++) {
      const lease = await locks.acquirePersistenceLease(join(dir, 'state'), { timeoutMs: 15000 })
      const path = join(dir, 'counter')
      const previous = fs.existsSync(path) ? Number(fs.readFileSync(path, 'utf8')) : 0
      await new Promise(resolve => setTimeout(resolve, 5))
      lease.assertOwned()
      fs.writeFileSync(path, String(previous + 1))
      lease.release()
    }
    process.send('done')
  }
} catch (error) {
  process.send({ error: error.message })
}
process.disconnect()
