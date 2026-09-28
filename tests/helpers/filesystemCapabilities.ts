import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function probeFileSymlinks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'ovogo-symlink-capability-'))
  try {
    const target = join(directory, 'target')
    const link = join(directory, 'link')
    writeFileSync(target, 'probe')
    symlinkSync(target, link, 'file')
    if (readFileSync(link, 'utf8') !== 'probe') throw new Error('Symlink probe changed file content')
    return true
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false
    throw error
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

export const canCreateFileSymlinks = probeFileSymlinks()
export const nativeFileMode = (posixMode: number): number => process.platform === 'win32' ? ((posixMode & 0o200) ? 0o666 : 0o444) : posixMode
