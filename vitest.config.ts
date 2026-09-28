import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    env: { OVOGO_STATE_DIR: process.env.OVOGO_STATE_DIR ?? resolve('.artifacts', 'test-runtime') },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.claude/worktrees/**',
      '**/claude-code/**',
      '**/loop-kit/**',
    ],
  },
})
