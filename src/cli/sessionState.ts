import type { SharedPrompt } from '../ui/input.js'
export interface CliSessionState {
  prompt: SharedPrompt | null
  saveOnExit: (() => void) | null
}
