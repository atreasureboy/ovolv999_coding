/**
 * Tests for the cleanup utility.
 *
 * We mock process.on/off to avoid actually emitting signals (which
 * would crash the vitest worker process).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerCleanup } from '../src/utils/cleanup.js'

describe('registerCleanup', () => {
  let originalIsTTY: boolean | undefined
  let originalExitCode: typeof process.exitCode
  let onSpy: ReturnType<typeof vi.spyOn>
  let offSpy: ReturnType<typeof vi.spyOn>
  let exitSpy: ReturnType<typeof vi.spyOn>
  let registeredHandlers: Map<string, (...args: unknown[]) => void>

  beforeEach(() => {
    originalIsTTY = process.stdin.isTTY
    originalExitCode = process.exitCode
    registeredHandlers = new Map()
    onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string, handler: (...args: unknown[]) => void) => {
      registeredHandlers.set(event, handler)
      return process
    }) as never)
    offSpy = vi.spyOn(process, 'off').mockImplementation(((event: string) => {
      registeredHandlers.delete(event)
      return process
    }) as never)
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
  })

  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: originalIsTTY,
      writable: true,
    })
    process.exitCode = originalExitCode
    onSpy.mockRestore()
    offSpy.mockRestore()
    exitSpy.mockRestore()
  })

  it('calls onCleanup when cleanup function is invoked', async () => {
    const onCleanup = vi.fn()
    const cleanup = registerCleanup({ onCleanup })
    await cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('is idempotent — calling cleanup twice does not call onCleanup twice', async () => {
    const onCleanup = vi.fn()
    const cleanup = registerCleanup({ onCleanup })
    await cleanup()
    await cleanup()
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('registers handlers for SIGTERM and SIGHUP', () => {
    registerCleanup()
    expect(registeredHandlers.has('SIGTERM')).toBe(true)
    expect(registeredHandlers.has('SIGHUP')).toBe(true)
  })

  it('registers handlers for uncaughtException and unhandledRejection', () => {
    registerCleanup()
    expect(registeredHandlers.has('uncaughtException')).toBe(true)
    expect(registeredHandlers.has('unhandledRejection')).toBe(true)
  })

  it('calls onCleanup when SIGTERM handler fires', async () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('SIGTERM')!
    handler()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when SIGHUP handler fires', async () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('SIGHUP')!
    handler()
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(130))
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when uncaughtException handler fires', async () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('uncaughtException')!
    handler(new Error('boom'))
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('calls onCleanup when unhandledRejection handler fires', async () => {
    const onCleanup = vi.fn()
    registerCleanup({ onCleanup })
    const handler = registeredHandlers.get('unhandledRejection')!
    // Use a pre-rejected promise but catch it locally to avoid vitest detecting it
    const rejected = Promise.reject(new Error('oops'))
    rejected.catch(() => {}) // prevent unhandled rejection warning
    handler(rejected)
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1))
    expect(onCleanup).toHaveBeenCalledTimes(1)
  })

  it('unregisters all handlers when cleanup function is called', async () => {
    const cleanup = registerCleanup()
    await cleanup()
    // After cleanup, handlers should be removed
    expect(registeredHandlers.has('SIGTERM')).toBe(false)
    expect(registeredHandlers.has('SIGHUP')).toBe(false)
    expect(registeredHandlers.has('uncaughtException')).toBe(false)
    expect(registeredHandlers.has('unhandledRejection')).toBe(false)
  })

  it('handles missing onCleanup gracefully', () => {
    const cleanup = registerCleanup()
    expect(() => cleanup()).not.toThrow()
  })

  it('survives onCleanup throwing', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const onCleanup = vi.fn(() => { throw new Error('cleanup failed') })
    const cleanup = registerCleanup({ onCleanup })
    await expect(cleanup()).resolves.toBeUndefined()
    expect(process.exitCode).toBe(1)
    stderr.mockRestore()
  })

  it('disables raw mode during cleanup', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true })
    const setRawSpy = vi.fn()
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRawSpy, writable: true, configurable: true })
    const cleanup = registerCleanup()
    await cleanup()
    expect(setRawSpy).toHaveBeenCalledWith(false)
  })

  it('does not call setRawMode when not TTY', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true })
    const setRawSpy = vi.fn()
    Object.defineProperty(process.stdin, 'setRawMode', { value: setRawSpy, writable: true, configurable: true })
    const cleanup = registerCleanup()
    await cleanup()
    expect(setRawSpy).not.toHaveBeenCalled()
  })
})
