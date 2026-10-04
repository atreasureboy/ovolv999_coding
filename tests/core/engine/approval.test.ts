import { describe, expect, it } from 'vitest'
import { ApprovalBroker, type ApprovalRequest } from '../../../src/core/approvalBroker.js'
import { requestOperationApproval } from '../../../src/core/engine/approval.js'
import { resolveExecutionPolicy } from '../../../src/core/executionPolicy.js'
import { PermissionManager } from '../../../src/core/permissionSystem.js'
import type { EngineConfig } from '../../../src/core/types.js'

function setup() {
  const requests: ApprovalRequest[] = []
  const broker = new ApprovalBroker()
  broker.attachHost({
    request: (request) => {
      requests.push(request)
      return Promise.resolve({
        requestId: request.requestId,
        inputDigest: request.inputDigest,
        cwd: request.cwd,
        action: 'allow',
        scope: 'session',
        status: 'decided',
      })
    },
  })
  const config: EngineConfig = {
    cwd: process.cwd(),
    model: 'offline',
    apiKey: 'offline',
    maxIterations: 1,
    permissionMode: 'ask',
    approvalBroker: broker,
  }
  return {
    requests,
    config,
    state: { config, permissions: new PermissionManager(), getRun: () => null },
    context: { cwd: config.cwd, runId: 'approval-test', signal: new AbortController().signal },
  }
}

describe('operation approval policy binding', () => {
  it('requests another approval when execution policy changes after a session grant', async () => {
    const { requests, config, state, context } = setup()
    const input = { command: 'npm test' }
    expect(
      (await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)).approved,
    ).toBe(true)
    expect(
      (await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)).approved,
    ).toBe(true)
    expect(requests).toHaveLength(1)
    config.executionPolicy = resolveExecutionPolicy(
      { envAllowlist: ['OVO_TEST_EXPLICIT'] },
      config.cwd,
    )
    expect(
      (await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)).approved,
    ).toBe(true)
    expect(requests).toHaveLength(2)
    expect(requests[1].policyDigest).not.toBe(requests[0].policyDigest)
  })

  it('requests another approval when permission rules change after a session grant', async () => {
    const { requests, state, context } = setup()
    const input = { command: 'npm test' }
    await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)
    state.permissions.addRule({
      toolName: 'Bash',
      ruleContent: 'git push*',
      behavior: 'deny',
      source: 'user',
    })
    await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)
    expect(requests).toHaveLength(2)
    expect(requests[1].policyDigest).not.toBe(requests[0].policyDigest)
  })

  it('shows the complete Bash input including background and timeout options', async () => {
    const { requests, state, context } = setup()
    const input = { command: 'npm test', timeout: 14400000, run_in_background: true }
    await requestOperationApproval(state, 'Bash', input, 'needs-approval', context)
    expect(JSON.parse(requests[0].preview)).toEqual(input)
  })
})
