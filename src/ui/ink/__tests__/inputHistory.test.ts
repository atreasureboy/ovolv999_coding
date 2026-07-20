import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'

// Set HOME to a temp dir before importing the module under test,
// so history is written to a sandboxed location.
const tmpDir = mkdtempSync(join(tmpdir(), 'ovolv999-hist-'))
process.env.HOME = tmpDir

const { loadInputHistory, saveInputHistory, clearInputHistory, getHistoryFilePath } =
  await import('../../../utils/inputHistory.js')

describe('inputHistory', () => {
  beforeEach(() => {
    clearInputHistory()
  })

  afterEach(() => {
    clearInputHistory()
  })

  it('returns empty array when no history file', () => {
    expect(loadInputHistory()).toEqual([])
  })

  it('saves and loads history', () => {
    saveInputHistory('hello world')
    saveInputHistory('second prompt')
    const history = loadInputHistory()
    expect(history).toContain('hello world')
    expect(history).toContain('second prompt')
  })

  it('returns most recent first', () => {
    saveInputHistory('first')
    saveInputHistory('second')
    saveInputHistory('third')
    const history = loadInputHistory()
    expect(history[0]).toBe('third')
    expect(history[1]).toBe('second')
    expect(history[2]).toBe('first')
  })

  it('deduplicates entries', () => {
    saveInputHistory('same')
    saveInputHistory('different')
    saveInputHistory('same')
    const history = loadInputHistory()
    const sameCount = history.filter((h) => h === 'same').length
    expect(sameCount).toBe(1)
  })

  it('ignores empty strings', () => {
    saveInputHistory('')
    saveInputHistory('   ')
    expect(loadInputHistory()).toEqual([])
  })

  it('clears history', () => {
    saveInputHistory('test')
    clearInputHistory()
    expect(loadInputHistory()).toEqual([])
  })

  it('file path is under .ovolv999', () => {
    expect(getHistoryFilePath()).toContain('.ovolv999')
    expect(getHistoryFilePath()).toContain('history.jsonl')
  })
})
