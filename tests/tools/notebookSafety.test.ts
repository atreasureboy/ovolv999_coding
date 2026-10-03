import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { FileReadState } from '../../src/core/fileState.js'
import type { ToolContext } from '../../src/core/types.js'
import { NotebookEditTool } from '../../src/tools/notebookEdit.js'
import { FileWriteTool } from '../../src/tools/fileWrite.js'

let cwd: string
let path: string
let context: ToolContext
const tool = new NotebookEditTool()

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'notebook-safety-'))
  path = join(cwd, 'test.ipynb')
  writeFileSync(path, JSON.stringify({ nbformat: 4, cells: [{ id: 'first', cell_type: 'code', source: ['old\n'], metadata: {} }] }))
  context = { cwd, permissionMode: 'auto', fileState: new FileReadState() }
  context.fileState!.markFileRead(path, readFileSync(path, 'utf8'))
})
afterEach(() => rmSync(cwd, { recursive: true, force: true }))

describe('NotebookEdit content and read state', () => {
  it('allows replacing a cell with an empty source', async () => {
    const result = await tool.execute({ notebook_path: path, cell_id: '0', new_source: '' }, context)
    expect(result.isError).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).cells[0].source).toBe('')
  })

  it('rejects an index with trailing characters without changing any cell', async () => {
    const original = readFileSync(path, 'utf8')
    expect((await tool.execute({ notebook_path: path, cell_id: '0junk', new_source: 'changed' }, context)).isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('refuses a notebook changed after Read', async () => {
    const changed = readFileSync(path, 'utf8').replace('old', 'new')
    writeFileSync(path, changed)
    const result = await tool.execute({ notebook_path: path, cell_id: '0', new_source: 'changed' }, context)
    expect(result.isError).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe(changed)
  })

  it('refreshes read state so a later Write can safely continue', async () => {
    expect((await tool.execute({ notebook_path: path, cell_id: '0', new_source: 'changed' }, context)).isError).toBe(false)
    expect((await new FileWriteTool().execute({ file_path: path, content: '{}' }, context)).isError).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('{}')
  })

  it('requires Read before editing an existing notebook', async () => {
    context.fileState = new FileReadState()
    const original = readFileSync(path, 'utf8')
    const result = await tool.execute({ notebook_path: path, cell_id: '0', new_source: 'changed' }, context)
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/read/i)
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it.each([null, { cells: [null] }])('reports malformed notebook structure as a result', async notebook => {
    writeFileSync(path, JSON.stringify(notebook))
    context.fileState!.markFileRead(path, readFileSync(path, 'utf8'))
    expect((await tool.execute({ notebook_path: path, cell_id: '0', new_source: 'changed' }, context)).isError).toBe(true)
  })
})
