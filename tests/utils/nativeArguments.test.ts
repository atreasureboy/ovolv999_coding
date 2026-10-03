import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getClipboardImagePath, getImageInfo, getResizedPath, validateImage } from '../../src/utils/imageInput.js'
import { notifyLinux, notifyMacOS, notifyWindows } from '../../src/utils/notifier.js'
import { openDiffInIDE, openInIDE } from '../../src/utils/ide.js'
import { deleteSecret, getSecret, setSecret } from '../../src/utils/keychain.js'

vi.mock('node:child_process', () => ({ execSync: vi.fn(), execFileSync: vi.fn() }))
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ovogo-native-arguments-'))
  vi.stubEnv('HOME', directory)
  vi.stubEnv('USERPROFILE', directory)
  vi.mocked(execSync).mockReset().mockReturnValue('')
  vi.mocked(execFileSync).mockReset().mockReturnValue(Buffer.alloc(0))
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }) })

describe('native program argument contracts with real files', () => {
  it('resizes a file beside its original even when its directory contains the extension', () => {
    const parent = join(directory, 'folder.png')
    mkdirSync(parent)
    const source = join(parent, 'literal-$HOME-%TEMP%-image.png')
    const image = Buffer.alloc(24)
    image.write('IHDR', 12, 'ascii'); image.writeUInt32BE(5000, 16); image.writeUInt32BE(100, 20)
    writeFileSync(source, image)
    const destination = join(parent, 'literal-$HOME-%TEMP%-image_resized.png')
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === 'convert') writeFileSync(String(args?.at(-1)), image)
      return Buffer.alloc(0)
    })
    expect(getResizedPath(source)).toBe(destination)
    expect(execFileSync).toHaveBeenCalledWith('convert', [source, '-resize', '4096x4096>', destination], expect.any(Object))
    expect(existsSync(destination)).toBe(true)
  })

  it('does not accept a directory as an image', () => {
    const path = join(directory, 'folder.png')
    mkdirSync(path)
    expect(validateImage(path).valid).toBe(false)
    expect(getImageInfo(path, true)).toBeNull()
  })

  it('writes clipboard stdout bytes directly and leaves no empty failed capture', () => {
    const bytes = Buffer.from('clipboard image bytes')
    vi.mocked(execFileSync).mockImplementation((command) => {
      if (command === 'pngpaste') throw new Error('unavailable')
      return bytes
    })
    const first = getClipboardImagePath()
    const second = getClipboardImagePath()
    expect(first).not.toBeNull()
    expect(second).not.toBe(first)
    expect(execFileSync).toHaveBeenCalledWith('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], expect.any(Object))
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error('unavailable') })
    expect(getClipboardImagePath()).toBeNull()
    expect(readdirSync(join(directory, '.ovolv999', 'images'))).toHaveLength(2)
  })

  it('passes native notification content without shell parsing or double PowerShell escaping', () => {
    const options = { title: "O'Brien $HOME %TEMP%", body: 'body `literal` "quote"' }
    expect(notifyMacOS(options).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('osascript', ['-e', expect.stringContaining(options.title)], expect.any(Object))
    expect(notifyLinux(options).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('notify-send', ['--app-name=ovolv999', '--', options.title, options.body], expect.any(Object))
    expect(notifyWindows(options).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('powershell', ['-NoProfile', '-NonInteractive', '-Command', expect.stringContaining("$balloon.BalloonTipTitle = 'O''Brien $HOME %TEMP%'")], expect.any(Object))
  })

  it('keeps leading-dash notification text after options and their terminator', () => {
    const options = { title: '--wait', body: '--expire-time=0', subtitle: 'category with spaces' }
    expect(notifyLinux(options).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('notify-send', [
      '--app-name=ovolv999', '--hint=string:category:category with spaces', '--', options.title, options.body,
    ], expect.any(Object))
  })

  it('passes editor file paths literally and gives line positions as proper arguments', () => {
    const file = join(directory, 'literal-$HOME-%TEMP%.ts')
    writeFileSync(file, 'contents')
    expect(openInIDE(file, { ide: 'vim', line: 12 }).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('vim', ['+12', file], expect.any(Object))
    expect(openInIDE(file, { ide: 'vscode', line: 12, column: 3 }).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('code', ['--goto', file + ':12:3'], expect.any(Object))
    expect(openDiffInIDE(file, file, { ide: 'cursor' }).success).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('cursor', ['--diff', file, file], expect.any(Object))
  })

  it('updates and creates macOS secrets atomically with literal key and value arguments', () => {
    const key = "O'Brien $HOME"
    const value = 'private literal value with spaces'
    expect(setSecret(key, value)).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('security', ['add-generic-password', '-U', '-s', 'ovolv999', '-a', key, '-w', value], expect.any(Object))
    vi.mocked(execFileSync).mockReturnValue(value + '\n')
    expect(getSecret(key)).toBe(value)
    expect(execFileSync).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'ovolv999', '-a', key, '-w'], expect.any(Object))
    expect(deleteSecret(key)).toBe(true)
    expect(execFileSync).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', 'ovolv999', '-a', key], expect.any(Object))
  })
})
