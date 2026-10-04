import type { ApprovalDecision, ApprovalHost, ApprovalRequest, ApprovalScope, ApprovalStatus } from '../core/approvalBroker.js'
import type { SharedPrompt } from '../ui/input.js'
import type { UIStore } from '../ui/ink/store.js'
import { formatApprovalDisplay } from '../ui/approvalDisplay.js'

function decision(request: ApprovalRequest, action: ApprovalDecision['action'], scope: ApprovalScope = 'once', status: ApprovalStatus = 'decided', feedback?: string, rule?: string): ApprovalDecision {
  return { requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd, action, scope, status, ...(feedback ? { feedback } : {}), ...(rule ? { rule } : {}) }
}

export function createTerminalApprovalHost({ prompt, writeOut }: {
  prompt: SharedPrompt
  writeOut: (text: string) => void
}): ApprovalHost {
  return {
    async request(request) {
      if (request.signal.aborted) return decision(request, 'deny', 'once', 'cancelled')
      if (!prompt.isTTY) return decision(request, 'deny', 'once', 'needs_input')
      writeOut(`\nPermission: ${formatApprovalDisplay(request.tool)} [${formatApprovalDisplay(request.riskLevel ?? 'needs-approval')}]\nDirectory: ${formatApprovalDisplay(request.cwd)}\n${formatApprovalDisplay(request.preview)}\n[y] once · [s] same complete operation in this directory under the current settings for this session · [n] deny${request.ruleSuggestion ? ' · [r] review persistent rule' : ''}\n`)
      const answer = await prompt.readLine('Approval: ', request.signal)
      if (answer.aborted || request.signal.aborted) return decision(request, 'deny', 'once', 'cancelled')
      if (answer.eof) return decision(request, 'deny', 'once', 'needs_input')
      const choice = answer.text.trim().toLowerCase()
      if (choice === 'y') return decision(request, 'allow')
      if (choice === 's') return decision(request, 'allow', 'session')
      if (choice === 'r' && request.ruleSuggestion) {
        writeOut(`Persist this exact rule:\n${formatApprovalDisplay(request.ruleSuggestion)}\n[y] confirm this rule · [n] deny\n`)
        const confirmation = await prompt.readLine('Confirm rule: ', request.signal)
        if (confirmation.aborted || request.signal.aborted) return decision(request, 'deny', 'once', 'cancelled')
        if (confirmation.eof) return decision(request, 'deny', 'once', 'needs_input')
        return confirmation.text.trim().toLowerCase() === 'y'
          ? decision(request, 'allow', 'rule', 'decided', undefined, request.ruleSuggestion)
          : decision(request, 'deny')
      }
      return decision(request, 'deny', 'once', 'decided', choice === 'n' ? undefined : answer.text.trim())
    },
  }
}

export function createInkApprovalHost(store: UIStore): ApprovalHost {
  return {
    async request(request) {
      if (request.signal.aborted) return decision(request, 'deny', 'once', 'cancelled')
      const result = await store.showPermissionDialog({
        toolName: request.tool, preview: request.preview, riskLevel: request.riskLevel ?? 'needs-approval',
        requestId: request.requestId, inputDigest: request.inputDigest, cwd: request.cwd, signal: request.signal,
        ruleSuggestion: request.ruleSuggestion,
      })
      if (request.signal.aborted) return decision(request, 'deny', 'once', 'cancelled')
      return decision(request, result.approved ? 'allow' : 'deny', result.scope ?? (result.alwaysAllow ? 'session' : 'once'), 'decided', result.feedback, result.rule)
    },
  }
}
