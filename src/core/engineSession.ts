import { EventLog } from './eventLog.js'
import { readSessionSnapshot } from './sessionManager.js'
import type { EngineConfig } from './types.js'

export function bindEngineSession(config: EngineConfig, sessionDir: string): EngineConfig {
  return {
    ...config,
    sessionDir,
    approvalSessionId: readSessionSnapshot(sessionDir).sessionId,
    usageLedger: undefined,
    usageOwnerId: undefined,
    eventLog: config.eventLog ? new EventLog(sessionDir) : undefined,
    systemPrompt: config.sessionSystemPrompt?.(sessionDir) ?? config.systemPrompt,
  }
}
