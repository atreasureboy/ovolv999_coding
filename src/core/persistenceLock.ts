import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'
import { captureProcessIdentity, captureProcessIdentitySync, inspectProcessIdentity, type ProcessIdentity } from './processIdentity.js'

export interface PersistenceLockOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export interface PersistenceLease {
  owner: ProcessIdentity
  token: string
  assertOwned(): void
  release(): void
}

export class PersistenceLockBusyError extends Error {
  constructor(path: string) {
    super(`Persistence lock is busy at ${path}; write was not committed. Retry asynchronously or stop the verified owner.`)
    this.name = 'PersistenceLockBusyError'
  }
}

interface Contender {
  owner: ProcessIdentity
  token: string
  path: string
  ticket: number | null
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function legacyBarrier(filePath: string): void {
  const path = `${filePath}.lock`
  if (!existsSync(path)) return
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as { pid?: number }
    if (!Number.isInteger(record.pid) || record.pid! <= 0) throw new Error('missing owner')
    try { process.kill(record.pid!, 0) } catch (error) {
      if (code(error) === 'ESRCH') return
      throw error
    }
  } catch (error) {
    if (code(error) === 'ENOENT') return
    throw new Error(`Legacy persistence lock ${path} has an unverified owner; preserve it and inspect the owner before recovery`, { cause: error })
  }
  throw new PersistenceLockBusyError(path)
}

function entries(root: string): Contender[] {
  return readdirSync(root).map(name => {
    try {
      const decoded = JSON.parse(Buffer.from(name, 'base64url').toString('utf8')) as { owner: ProcessIdentity; token: string }
      if (!decoded.owner || !Number.isInteger(decoded.owner.pid) || typeof decoded.owner.hostname !== 'string' || typeof decoded.owner.birthId !== 'string' || typeof decoded.token !== 'string') throw new Error('invalid identity')
      const path = join(root, name)
      let ticket: number | null = null
      try {
        ticket = Number(readFileSync(join(path, 'ticket'), 'utf8'))
        if (!Number.isSafeInteger(ticket) || ticket < 1) throw new Error('invalid ticket')
      } catch (error) { if (code(error) !== 'ENOENT') throw error }
      return { ...decoded, path, ticket }
    } catch (error) {
      throw new Error(`Persistence coordination data is invalid at ${join(root, name)}; preserve it for diagnosis`, { cause: error })
    }
  }).filter(entry => existsSync(entry.path))
}

function remove(entry: Contender): void {
  for (const name of ['ticket', 'ticket.tmp']) {
    try { unlinkSync(join(entry.path, name)) } catch (error) { if (code(error) !== 'ENOENT') throw error }
  }
  try { rmdirSync(entry.path) } catch (error) { if (code(error) !== 'ENOENT') throw error }
}

function begin(filePath: string, owner: ProcessIdentity): { root: string; contender: Contender } {
  legacyBarrier(filePath)
  const root = resolve(`${filePath}.lock.owners`)
  mkdirSync(root, { recursive: true })
  const token = randomUUID()
  const path = join(root, Buffer.from(JSON.stringify({ owner, token })).toString('base64url'))
  mkdirSync(path)
  return { root, contender: { owner, token, path, ticket: null } }
}

function choose(root: string, contender: Contender): void {
  const ticket = Math.max(0, ...entries(root).map(entry => entry.ticket ?? 0)) + 1
  if (!Number.isSafeInteger(ticket)) throw new Error('Persistence ticket exhausted')
  const fd = openSync(join(contender.path, 'ticket.tmp'), 'wx')
  try { writeFileSync(fd, String(ticket)); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(join(contender.path, 'ticket.tmp'), join(contender.path, 'ticket'))
  contender.ticket = ticket
}

function ahead(entry: Contender, contender: Contender): boolean {
  return entry.token !== contender.token && (entry.ticket === null || entry.ticket < contender.ticket! || (entry.ticket === contender.ticket && entry.token < contender.token))
}

function lease(contender: Contender): PersistenceLease {
  let released = false
  return {
    owner: { ...contender.owner }, token: contender.token,
    assertOwned() {
      if (released || !existsSync(contender.path) || Number(readFileSync(join(contender.path, 'ticket'), 'utf8')) !== contender.ticket) throw new Error('Persistence ownership was lost; write was not committed')
    },
    release() { if (!released) { remove(contender); released = true } },
  }
}

export function acquirePersistenceLeaseSync(filePath: string): PersistenceLease {
  const owner = captureProcessIdentitySync()
  if (!owner) throw new Error('Cannot verify local process identity; persistence is unavailable')
  const { root, contender } = begin(filePath, owner)
  try {
    choose(root, contender)
    for (const entry of entries(root)) {
      if (!ahead(entry, contender)) continue
      let dead = false
      if (entry.owner.hostname === owner.hostname) {
        try { process.kill(entry.owner.pid, 0) } catch (error) { dead = code(error) === 'ESRCH' }
      }
      if (dead) remove(entry)
      else throw new PersistenceLockBusyError(filePath)
    }
    return lease(contender)
  } catch (error) { remove(contender); throw error }
}

function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason instanceof Error ? signal.reason : new Error('Persistence wait aborted')) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve() }, 15)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

export async function acquirePersistenceLease(filePath: string, options: PersistenceLockOptions = {}): Promise<PersistenceLease> {
  options.signal?.throwIfAborted()
  const owner = await captureProcessIdentity()
  if (!owner) throw new Error('Cannot verify local process identity; persistence is unavailable')
  const { root, contender } = begin(filePath, owner)
  const deadline = Date.now() + (options.timeoutMs ?? 2000)
  try {
    choose(root, contender)
    for (;;) {
      options.signal?.throwIfAborted()
      let blocked = false
      for (const entry of entries(root)) {
        if (!ahead(entry, contender)) continue
        const status = await inspectProcessIdentity(entry.owner)
        if (status === 'dead' || status === 'mismatch') remove(entry)
        else blocked = true
      }
      if (!blocked) return lease(contender)
      if (Date.now() >= deadline) throw new PersistenceLockBusyError(filePath)
      await pause(options.signal)
    }
  } catch (error) { remove(contender); throw error }
}

export function withPersistenceLock<T>(filePath: string, action: () => T, _timeoutMs = 2000): T {
  const guard = acquirePersistenceLeaseSync(filePath)
  try { guard.assertOwned(); return action() } finally { guard.release() }
}

export async function withPersistenceLockAsync<T>(filePath: string, action: () => T | Promise<T>, options: PersistenceLockOptions = {}): Promise<T> {
  const guard = await acquirePersistenceLease(filePath, options)
  try {
    guard.assertOwned()
    const value = await action()
    guard.assertOwned()
    return value
  } finally { guard.release() }
}
