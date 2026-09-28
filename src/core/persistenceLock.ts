import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs'

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function recoverDeadOwner(path: string): void {
  let recovery: number
  try {
    recovery = openSync(`${path}.recovery`, 'wx')
  } catch {
    return
  }
  try {
    let dead = false
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try {
          process.kill(owner.pid!, 0)
        } catch (error) {
          dead = errorCode(error) === 'ESRCH'
        }
      }
    } catch {
      try { dead = Date.now() - statSync(path).mtimeMs > 30_000 } catch { return }
    }
    if (dead) {
      try { unlinkSync(path) } catch { return }
    }
  } finally {
    closeSync(recovery)
    try { unlinkSync(`${path}.recovery`) } catch (error) { void error }
  }
}

export function withPersistenceLock<T>(filePath: string, action: () => T, timeoutMs = 2_000): T {
  const path = `${filePath}.lock`
  const deadline = Date.now() + timeoutMs
  const sleeper = new Int32Array(new SharedArrayBuffer(4))
  let fd: number
  for (;;) {
    try {
      fd = openSync(path, 'wx')
      break
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      recoverDeadOwner(path)
      if (Date.now() >= deadline) throw new Error('Persistence lock is busy; write was not committed', { cause: error })
      Atomics.wait(sleeper, 0, 0, 10)
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }))
    return action()
  } finally {
    closeSync(fd)
    try { unlinkSync(path) } catch (error) { void error }
  }
}
