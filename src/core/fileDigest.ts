import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

export async function digestFile(path: string): Promise<string | null> {
  const hash = createHash('sha256')
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes: unknown = chunk
      if (!Buffer.isBuffer(bytes)) throw new Error('Unexpected file stream data')
      hash.update(bytes)
    }
    return hash.digest('hex')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
