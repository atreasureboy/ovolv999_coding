import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { FileWriteTool } from '../../src/tools/fileWrite.js'
import { FileEditTool } from '../../src/tools/fileEdit.js'
import { FileReadState } from '../../src/core/fileState.js'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const fixture = () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ovo-file-evidence-'))
  roots.push(cwd)
  return { cwd, permissionMode: 'auto' as const, fileState: new FileReadState() }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('publishes durable before/expected evidence before actual Write and observes its final bytes', async () => {
  const context = fixture()
  const file = join(context.cwd, 'created.txt')
  const evidence: unknown[] = [], observations: unknown[] = []
  const result = await new FileWriteTool().execute({ file_path: file, content: 'created' }, {
    ...context,
    recordFileEvidence: value => { expect(existsSync(file)).toBe(false); evidence.push(value) },
    recordFileObservation: value => { expect(readFileSync(file, 'utf8')).toBe('created'); observations.push(value) },
  })
  expect(result.isError).toBe(false)
  expect(evidence).toEqual([expect.objectContaining({ path: file, beforeHash: null, expectedHash: digest('created'), completion: 'write-only' })])
  expect(observations).toEqual([expect.objectContaining({ hash: digest('created'), final: true })])
})

it('does not mutate when evidence persistence fails before the atomic write', async () => {
  const context = fixture()
  const file = join(context.cwd, 'blocked.txt')
  const result = await new FileWriteTool().execute({ file_path: file, content: 'must not exist' }, { ...context, recordFileEvidence: () => { throw new Error('durable intent refused') } })
  expect(result.isError).toBe(true)
  expect(existsSync(file)).toBe(false)
})

it('preserves applied bytes when observation persistence fails after the write', async () => {
  const context = fixture()
  const file = join(context.cwd, 'applied.txt')
  const result = await new FileWriteTool().execute({ file_path: file, content: 'retained' }, { ...context, recordFileObservation: () => { throw new Error('receipt publication interrupted') } })
  expect(result.isError).toBe(true)
  expect(readFileSync(file, 'utf8')).toBe('retained')
})

it('keeps Edit write evidence separate from completion of its formatting stage', async () => {
  const context = fixture()
  const file = join(context.cwd, 'source.txt')
  writeFileSync(file, 'before')
  context.fileState.markFileRead(file, 'before')
  const evidence: unknown[] = [], observations: unknown[] = []
  const result = await new FileEditTool().execute({ file_path: file, old_string: 'before', new_string: 'after' }, { ...context, recordFileEvidence: value => { evidence.push(value) }, recordFileObservation: value => { observations.push(value) } })
  expect(result.isError).toBe(false)
  expect(evidence).toEqual([expect.objectContaining({ beforeHash: digest('before'), expectedHash: digest('after'), completion: 'format-pending' })])
  expect(observations).toEqual([expect.objectContaining({ hash: digest('after'), final: false }), expect.objectContaining({ hash: digest('after'), final: true })])
})
