import { randomUUID } from 'node:crypto'
import { approvalInputDigest } from '../approvalBroker.js'
import { resolveManagedExecutionPolicy } from '../executionPolicy.js'
import type { PermissionManager } from '../permissionSystem.js'
import type { RunContext } from '../runContext.js'
import type { EngineConfig, ToolContext, ToolResult } from '../types.js'

export interface OperationApprovalState {
  config: EngineConfig
  permissions: PermissionManager
  getRun: () => RunContext | null
}

function policyDigest(state: OperationApprovalState): string {
  return approvalInputDigest({
    cwd: state.config.cwd,
    permissionMode: state.config.permissionMode,
    executionPolicy: resolveManagedExecutionPolicy(
      state.config.executionProfile,
      state.config.executionPolicy,
      state.config.cwd,
    ),
    mode: state.permissions.getMode(),
    rules: state.permissions.getRules(),
    revision: state.getRun()?.policyRevision ?? 0,
  })
}

export async function requestOperationApproval(
  state: OperationApprovalState,
  tool: string,
  input: Record<string, unknown>,
  riskLevel: 'safe' | 'needs-approval' | 'dangerous',
  context: Pick<ToolContext, 'cwd' | 'runId' | 'signal'>,
): Promise<{ approved: boolean; feedback?: string; status?: ToolResult['status'] }> {
  const inputDigest = approvalInputDigest(input)
  const cwd = context.cwd
  const reviewedPolicy = policyDigest(state)
  context.signal?.throwIfAborted()
  let result: { approved: boolean; feedback?: string; status?: ToolResult['status'] }
  if (state.config.approvalBroker) {
    const decision = await state.config.approvalBroker.request({
      requestId: randomUUID(),
      runId: context.runId ?? state.getRun()?.runId ?? randomUUID(),
      operationId: randomUUID(),
      inputDigest,
      policyDigest: reviewedPolicy,
      cwd,
      tool,
      preview: JSON.stringify(input, null, 2),
      riskLevel,
      signal: context.signal ?? new AbortController().signal,
    })
    result = {
      approved: decision.action === 'allow' && decision.status === 'decided',
      feedback: decision.feedback,
      ...(decision.status === 'needs_input'
        ? { status: 'needs_input' as const }
        : decision.status === 'cancelled'
          ? { status: 'cancelled' as const }
          : decision.status === 'stale'
            ? { status: 'blocked' as const }
            : {}),
    }
  } else if (state.config.requestPermission) {
    result = await state.config.requestPermission(tool, input, riskLevel)
  } else {
    return { approved: false, feedback: 'No approval channel is available.', status: 'needs_input' }
  }
  context.signal?.throwIfAborted()
  if (
    approvalInputDigest(input) !== inputDigest ||
    state.config.cwd !== cwd ||
    context.cwd !== cwd ||
    policyDigest(state) !== reviewedPolicy
  ) {
    return {
      approved: false,
      feedback:
        'Input, workspace, or execution policy changed during approval. Request approval again.',
      status: 'blocked',
    }
  }
  return result
}
