import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, renderStatusLine } from '../../src/ui/statusLineCustom.js'
let directory: string
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'ovogo-statusline-boundaries-')); vi.stubEnv('HOME', directory); vi.stubEnv('USERPROFILE', directory) })
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })
describe('custom status line boundaries', () => {
  it.each(['[null]', 'false', '{"script":42}'])('ignores malformed saved configuration: %s', raw => {
    mkdirSync(join(directory, '.ovolv999'))
    writeFileSync(join(directory, '.ovolv999', 'statusline.json'), raw)
    expect(loadConfig()).toBeNull()
    expect(renderStatusLine({ cwd: directory, model: 'test' })).toContain('test')
  })
  it('runs a custom script in the active project directory', () => {
    const script = `"${process.execPath}" -e "console.log(process.cwd())"`
    expect(renderStatusLine({ cwd: directory }, { script })).toBe(directory)
  })
})
