import { appendFileSync, closeSync, fstatSync, fsyncSync, openSync, readSync } from 'node:fs'

export function appendJsonlRecord(path: string, value: unknown): void {
  const payload = JSON.stringify(value) + '\n'
  const fd = openSync(path, 'a+')
  try {
    const size = fstatSync(fd).size
    if (size > 0) {
      const tail = Buffer.alloc(1)
      if (readSync(fd, tail, 0, 1, size - 1) !== 1) throw new Error('JSONL append boundary could not be read')
      if (tail[0] !== 10) appendFileSync(fd, '\n', 'utf8')
    }
    appendFileSync(fd, payload, 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
