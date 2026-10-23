import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import { OutcomeError } from '../outcome.js'

const sameFile = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino
const pathKey = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path

export class LoopReceiptPublisher {
  private readonly parent: Stats

  constructor(private readonly directory: string) {
    this.parent = this.checkDirectory()
  }

  private checkDirectory(): Stats {
    const current = lstatSync(this.directory)
    if (!current.isDirectory() || current.isSymbolicLink() || pathKey(realpathSync(this.directory)) !== pathKey(resolve(this.directory))
      || this.parent && !sameFile(current, this.parent)) throw new Error('Unsafe Loop receipt directory')
    return current
  }

  private checkLeaf(path: string, expected?: Stats): void {
    try {
      const current = lstatSync(path)
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || expected && !sameFile(current, expected)) throw new Error('Unsafe Loop receipt file')
    } catch (error) {
      if (expected || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  publish(leaf: 'DONE.flag' | 'OUTCOME.json', content: string, guard: () => void): void {
    const target = join(this.directory, leaf)
    const temporary = join(this.directory, `.${randomUUID()}.tmp`)
    let fd: number | undefined
    let staged: Stats | undefined
    try {
      guard()
      this.checkDirectory()
      this.checkLeaf(target)
      fd = openSync(temporary, 'wx', 0o600)
      staged = fstatSync(fd)
      this.checkLeaf(temporary, staged)
      const bytes = Buffer.from(content)
      let offset = 0
      while (offset < bytes.length) {
        const count = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!count) throw new Error('Loop receipt write made no progress')
        offset += count
      }
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      guard()
      this.checkDirectory()
      this.checkLeaf(target)
      this.checkLeaf(temporary, staged)
      renameSync(temporary, target)
      this.checkDirectory()
      this.checkLeaf(target, staged)
    } catch (error) {
      throw new OutcomeError('Loop receipt publication failed or its result is unknown; reopen for recovery', { code: 'recovery_required', scope: 'session' }, { cause: error })
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (staged) {
        try {
          this.checkDirectory()
          this.checkLeaf(temporary, staged)
          unlinkSync(temporary)
        } catch {}
      }
    }
  }
}
