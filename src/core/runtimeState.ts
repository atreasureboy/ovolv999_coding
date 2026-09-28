import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { dirname, join } from 'path'
import { homedir } from 'os'

export function runtimeStateRoot(): string {
  return process.env.OVOGO_STATE_DIR ?? join(homedir(), '.ovolv999', 'runtime')
}

export function durableWrite(path: string, value: unknown, exclusive = false): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = exclusive ? path : `${path}.${randomUUID()}.tmp`
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  if (!exclusive) {
    try { renameSync(temporary, path) } catch (error) { try { unlinkSync(temporary) } catch { throw error } throw error }
  }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r')
    try { fsyncSync(directory) } finally { closeSync(directory) }
  }
}
