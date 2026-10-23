import { existsSync, fsyncSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LoopReceiptPublisher } from '../../../src/core/autonomy/receiptPublisher.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), fsyncSync: vi.fn(actual.fsyncSync) }
})

const roots: string[] = []
afterEach(() => { vi.mocked(renameSync).mockReset(); vi.mocked(fsyncSync).mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'loop-receipt-'))
  roots.push(root)
  const directory = join(root, '.loop')
  mkdirSync(directory)
  return { root, directory, target: join(directory, 'OUTCOME.json'), publisher: new LoopReceiptPublisher(directory) }
}

it.each([false, true])('publishes complete receipt bytes with existing private leaf=%s', existing => {
  const f = setup()
  if (existing) writeFileSync(f.target, 'previous receipt')
  f.publisher.publish('OUTCOME.json', 'complete receipt\n', () => {})
  expect(readFileSync(f.target, 'utf8')).toBe('complete receipt\n')
  expect(readdirSync(f.directory)).toEqual(['OUTCOME.json'])
})

it.each([1, 2])('preserves the old receipt if ownership is lost at guard %s', failureAt => {
  const f = setup()
  writeFileSync(f.target, 'previous receipt')
  let guards = 0
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => { if (++guards === failureAt) throw new Error('ownership lost') })).toThrow(/reopen for recovery/)
  expect(readFileSync(f.target, 'utf8')).toBe('previous receipt')
  expect(readdirSync(f.directory)).toEqual(['OUTCOME.json'])
})

it.each(['fsync', 'rename'] as const)('preserves the old receipt after a staged %s failure', failure => {
  const f = setup()
  writeFileSync(f.target, 'previous receipt')
  const fail = () => { throw new Error('injected I/O failure') }
  if (failure === 'fsync') vi.mocked(fsyncSync).mockImplementationOnce(fail)
  else vi.mocked(renameSync).mockImplementationOnce(fail)
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => {})).toThrow(/reopen for recovery/)
  expect(readFileSync(f.target, 'utf8')).toBe('previous receipt')
  expect(readdirSync(f.directory)).toEqual(['OUTCOME.json'])
})

it('rejects a non-file receipt leaf without changing its contents', () => {
  const f = setup()
  mkdirSync(f.target)
  writeFileSync(join(f.target, 'user.txt'), 'unrelated data')
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => {})).toThrow(/reopen for recovery/)
  expect(readFileSync(join(f.target, 'user.txt'), 'utf8')).toBe('unrelated data')
})

it('rejects a hardlink replacing the receipt after staging without following it', () => {
  const f = setup()
  const outside = join(f.root, 'outside.txt')
  writeFileSync(outside, 'outside data')
  let guards = 0
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => { if (++guards === 2) linkSync(outside, f.target) })).toThrow(/reopen for recovery/)
  expect(readFileSync(outside, 'utf8')).toBe('outside data')
  expect(readFileSync(f.target, 'utf8')).toBe('outside data')
  expect(readdirSync(f.directory)).toEqual(['OUTCOME.json'])
})

it('replaces a hardlink introduced at the rename boundary without modifying its outside target', () => {
  const f = setup()
  const outside = join(f.root, 'outside.txt')
  writeFileSync(outside, 'outside data')
  const rename = vi.mocked(renameSync).getMockImplementation()!
  let replaced = false
  vi.mocked(renameSync).mockImplementationOnce((source, target) => {
    linkSync(outside, target)
    replaced = true
    rename(source, target)
  })
  f.publisher.publish('OUTCOME.json', 'complete receipt', () => {})
  expect(replaced).toBe(true)
  expect(readFileSync(outside, 'utf8')).toBe('outside data')
  expect(readFileSync(f.target, 'utf8')).toBe('complete receipt')
  expect(readdirSync(f.directory)).toEqual(['OUTCOME.json'])
})

it('rejects a replaced staged pathname and leaves its outside hardlink untouched', () => {
  const f = setup()
  const outside = join(f.root, 'outside.txt')
  writeFileSync(outside, 'outside data')
  let guards = 0
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => {
    if (++guards === 2) {
      const staged = join(f.directory, readdirSync(f.directory)[0])
      unlinkSync(staged)
      linkSync(outside, staged)
    }
  })).toThrow(/reopen for recovery/)
  expect(readFileSync(outside, 'utf8')).toBe('outside data')
  expect(existsSync(f.target)).toBe(false)
  expect(readdirSync(f.directory)).toHaveLength(1)
})

it.each(['directory', 'junction'] as const)('rejects parent replacement by a %s before rename', kind => {
  const f = setup()
  const moved = join(f.root, 'old-loop')
  const outside = join(f.root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'OUTCOME.json'), 'outside data')
  let guards = 0
  expect(() => f.publisher.publish('OUTCOME.json', 'replacement', () => {
    if (++guards === 2) {
      renameSync(f.directory, moved)
      if (kind === 'junction') symlinkSync(outside, f.directory, 'junction')
      else mkdirSync(f.directory)
    }
  })).toThrow(/reopen for recovery/)
  expect(readFileSync(join(outside, 'OUTCOME.json'), 'utf8')).toBe('outside data')
  expect(readdirSync(moved)).toHaveLength(1)
  if (kind === 'directory') expect(readdirSync(f.directory)).toEqual([])
})

it('rejects a junction receipt parent before staging', () => {
  const f = setup()
  const alias = join(f.root, 'alias')
  symlinkSync(f.directory, alias, 'junction')
  expect(() => new LoopReceiptPublisher(alias)).toThrow(/Unsafe Loop receipt directory/)
  expect(readdirSync(f.directory)).toEqual([])
})
