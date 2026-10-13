import type { SharedPrompt } from '../ui/input.js'
import type { ExecutionEngine } from '../core/engine.js'
export interface CliSessionState {
  prompt: SharedPrompt | null
  saveOnExit: (() => void) | null
  interrupt?: () => void | Promise<void>
  dispose?: () => Promise<void>
  getEngine?: () => ExecutionEngine
}
