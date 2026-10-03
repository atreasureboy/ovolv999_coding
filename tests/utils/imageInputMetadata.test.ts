import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  buildImageContentPart,
  getImageDimensions,
  getMimeType,
  validateImage,
} from '../../src/utils/imageInput.js'
import { expandAtMentions } from '../../src/ui/ink/expandAtMentions.js'

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
const bundledFile = join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'Git',
  'usr',
  'bin',
  'file.exe',
)
const fileExecutable =
  process.platform === 'win32' && existsSync(bundledFile) ? bundledFile : 'file'
let fileAvailable = false
try {
  execFileSync(fileExecutable, ['--version'], { stdio: 'pipe' })
  fileAvailable = true
} catch {
  fileAvailable = false
}

describe('image metadata and attachment policy', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'ovogo-image-metadata-'))
    if (fileAvailable && fileExecutable !== 'file') {
      vi.stubEnv('PATH', dirname(fileExecutable) + delimiter + (process.env.PATH ?? ''))
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(directory, { recursive: true, force: true })
  })

  it.skipIf(!fileAvailable)(
    'reads dimensions from the image rather than dimension-like filename text',
    () => {
      const path = join(directory, '999x777.png')
      writeFileSync(path, png)
      expect(getImageDimensions(path)).toEqual({ width: 1, height: 1 })
    },
  )

  it.skipIf(!fileAvailable)('treats shell-variable filename characters literally', () => {
    const variable = process.platform === 'win32' ? '%OVOGO_IMAGE_PROBE%' : '$OVOGO_IMAGE_PROBE'
    const path = join(directory, `literal${variable}.png`)
    const substituted = Buffer.from(png)
    substituted.writeUInt32BE(320, 16)
    substituted.writeUInt32BE(240, 20)
    writeFileSync(path, png)
    writeFileSync(join(directory, 'literalexpanded.png'), substituted)
    vi.stubEnv('OVOGO_IMAGE_PROBE', 'expanded')
    expect(getImageDimensions(path)).toEqual({ width: 1, height: 1 })
  })

  it.skipIf(!fileAvailable)('uses literal filenames in the non-PNG metadata fallback', () => {
    const variable = process.platform === 'win32' ? '%OVOGO_IMAGE_PROBE%' : '$OVOGO_IMAGE_PROBE'
    const path = join(directory, `999x777${variable}.gif`)
    const substituted = Buffer.from(gif)
    substituted.writeUInt16LE(320, 6)
    substituted.writeUInt16LE(240, 8)
    writeFileSync(path, gif)
    writeFileSync(join(directory, '999x777expanded.gif'), substituted)
    vi.stubEnv('OVOGO_IMAGE_PROBE', 'expanded')
    expect(getImageDimensions(path)).toEqual({ width: 1, height: 1 })
  })

  it('retains BMP mentions without adding BMP to the validated image formats', () => {
    const path = join(directory, 'legacy.bmp')
    writeFileSync(path, Buffer.from('BMfixture'))
    const expanded = expandAtMentions('Inspect @legacy.bmp', directory)
    expect(expanded.images).toEqual([
      { path: 'legacy.bmp', dataUrl: 'data:image/bmp;base64,Qk1maXh0dXJl' },
    ])
    expect(getMimeType(path)).toBe('application/octet-stream')
    expect(validateImage(path).valid).toBe(false)
  })

  it.each([
    ['picture.PNG', 'image/png'],
    ['picture.jpg', 'image/jpeg'],
    ['picture.jpeg', 'image/jpeg'],
    ['picture.gif', 'image/gif'],
    ['picture.webp', 'image/webp'],
  ])('builds matching content parts and mentions for %s', (filename, mimeType) => {
    const path = join(directory, filename)
    writeFileSync(path, png)
    const expanded = expandAtMentions(`Inspect @${filename}`, directory)
    const part = buildImageContentPart(path, 'high')
    expect(expanded.images[0].dataUrl).toBe(`data:${mimeType};base64,${png.toString('base64')}`)
    expect(part).toEqual({
      type: 'image_url',
      image_url: { url: expanded.images[0].dataUrl, detail: 'high' },
    })
  })
})
