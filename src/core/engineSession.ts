import { EventLog } from './eventLog.js'
import type { EngineConfig } from './types.js'

export function bindEngineSession(config: EngineConfig, sessionDir: string): EngineConfig {
  return {
    ...config,
    sessionDir,
    usageLedger: undefined,
    usageOwnerId: undefined,
    eventLog: config.eventLog ? new EventLog(sessionDir) : undefined,
    systemPrompt: config.sessionSystemPrompt?.(sessionDir) ?? config.systemPrompt,
  }
}
