import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import type * as FsApi from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveInstructions } from '../../src/core/instructionResolver.js'

const interference = vi.hoisted(() => ({ change: undefined as (() => void) | undefined }))

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof FsApi>()
  const read: typeof FsApi.readSync = (fd: number, buffer: NodeJS.ArrayBufferView, offsetOrOptions: number | FsApi.ReadOptions = {}, length?: number, position?: FsApi.ReadPosition | null) => {
    const count = typeof offsetOrOptions === 'number'
      ? original.readSync(fd, buffer, offsetOrOptions, length!, position ?? null)
      : original.readSync(fd, buffer, offsetOrOptions)
    if (count && interference.change) {
      const change = interference.change
      interference.change = undefined
      change()
    }
    return count
  }
  return { ...original, readSync: read }
})

let fixture: string
let path: string

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'ovogo-instruction-snapshot-'))
  path = join(fixture, 'AGENTS.md')
  mkdirSync(join(fixture, 'home'))
  vi.stubEnv('HOME', join(fixture, 'home'))
  vi.stubEnv('USERPROFILE', join(fixture, 'home'))
  writeFileSync(path, 'original rule')
})

afterEach(() => {
  interference.change = undefined
  vi.unstubAllEnvs()
  rmSync(fixture, { recursive: true, force: true })
})

it('rejects a same-size instruction edit after bytes were read', async () => {
  const initial = statSync(path)
  interference.change = () => {
    writeFileSync(path, 'modified rule')
    utimesSync(path, initial.atime, new Date(initial.mtimeMs + 1000))
  }
  await expect(resolveInstructions(fixture, [])).rejects.toMatchObject({ code: 'unreadable', path })
  expect(readFileSync(path, 'utf8')).toBe('modified rule')
})

it('rejects a replaced source inode after bytes were read', async () => {
  interference.change = () => {
    renameSync(path, join(fixture, 'previous.md'))
    writeFileSync(path, 'replaced rule')
  }
  await expect(resolveInstructions(fixture, [])).rejects.toMatchObject({ code: 'unreadable', path })
  expect(readFileSync(path, 'utf8')).toBe('replaced rule')
})
