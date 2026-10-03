import { writeFileSync } from 'fs'
import { resolve } from 'path'
export function updateProgressLog(cwd: string, step: string, nextAction: string): void {
  try {
    const log = {
      current_step: step,
      next_action: nextAction,
      timestamp: new Date().toISOString(),
      cwd,
    }
    writeFileSync(resolve(cwd, 'ovogo_progress.json'), JSON.stringify(log, null, 2), 'utf8')
  } catch (error) {
    void error
  }
}
