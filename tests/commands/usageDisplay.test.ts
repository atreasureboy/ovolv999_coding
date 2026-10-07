import { expect, it } from 'vitest'
import { UsageLedger } from '../../src/core/usageLedger.js'
import { CostTracker } from '../../src/core/costTracker.js'
import { diagnosticsCommands } from '../../src/commands/diagnosticsCommands.js'
import { sessionCommands } from '../../src/commands/sessionCommands.js'
import type { SlashCommandContext } from '../../src/commands/index.js'

it.each(['doctor', 'status'])('shows unknown request cost in /%s', async name => {
  const ledger = new UsageLedger({ pricing: () => null })
  ledger.recordUsage({ requestId: 'unknown', runId: 'run', familyId: 'family', model: 'opaque', kind: 'actual', inputTokens: 100, outputTokens: 10 })
  const tracker = new CostTracker(ledger)
  const context = { cwd: process.cwd(), history: [], engine: { getCostTracker: () => tracker, getModel: () => 'opaque', isPlanMode: () => false, getFileHistory: () => null, getBackgroundTaskManager: () => ({ listTasks: () => [] }), getTools: () => [], getConfig: () => ({}) } } as unknown as SlashCommandContext
  const command = [...diagnosticsCommands, ...sessionCommands].find(command => command.name === name)!
  const result = await command.handler('', context)
  expect(result).toHaveProperty('value', expect.stringContaining('cost unknown'))
  expect(result).not.toHaveProperty('value', expect.stringContaining('Cost: $0.0000'))
})
