import { expect, it } from 'vitest'
import { execManaged } from '../../src/core/executionBackend.js'

it('decodes UTF8 output split across successive stdout and stderr chunks', async () => {
  const text = '中🧩word'
  const script = `const bytes = Buffer.from(${JSON.stringify(text)}); let index = 0; function emit() { const chunk = bytes.subarray(index, index + 1); process.stdout.write(chunk); process.stderr.write(chunk); if (++index < bytes.length) setTimeout(emit, 40) } emit()`
  const result = await execManaged(process.execPath, ['-e', script])
  expect(result).toEqual({ stdout: text, stderr: text })
}, 15_000)
