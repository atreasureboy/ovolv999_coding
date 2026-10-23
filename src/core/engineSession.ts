import { EventLog } from './eventLog.js'
import { readSessionSnapshot } from './sessionManager.js'
import { workspaceIdentity } from './runContext.js'
import type { EngineConfig } from './types.js'

export function bindEngineSession(config: EngineConfig, sessionDir: string): EngineConfig {
  const sameSession = config.sessionDir !== undefined && workspaceIdentity(config.sessionDir) === workspaceIdentity(sessionDir)
  return {
    ...config,
    frozenVerificationPlan: sameSession ? config.frozenVerificationPlan : undefined,
    artifactPolicy: sameSession ? config.artifactPolicy : undefined,
    sessionDir,
    approvalSessionId: readSessionSnapshot(sessionDir).sessionId,
    usageLedger: undefined,
    usageOwnerId: undefined,
    eventLog: config.eventLog ? new EventLog(sessionDir) : undefined,
    systemPrompt: config.sessionSystemPrompt?.(sessionDir) ?? config.systemPrompt,
  }
}
