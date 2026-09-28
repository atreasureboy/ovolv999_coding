import { describe, expect, it } from 'vitest'
import { registerCleanup } from '../src/utils/cleanup.js'

describe('resource cleanup completion', () => {
  it('awaits asynchronous resources and shares one cleanup operation', async () => {
    let completions = 0
    const cleanup = registerCleanup({ onCleanup: async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
      completions++
    } })
    await Promise.all([cleanup(), cleanup()])
    expect(completions).toBe(1)
  })
})
