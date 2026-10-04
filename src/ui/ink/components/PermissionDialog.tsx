import { Text, Box, useInput } from 'ink'
import { useEffect, useState } from 'react'
import type { ApprovalScope } from '../../../core/approvalBroker.js'
import type { UIPermissionRequest } from '../store.js'
import { formatApprovalDisplay } from '../../approvalDisplay.js'

export type PermissionRequest = UIPermissionRequest

export function PermissionDialog({
  request,
  onResolve,
}: {
  request: PermissionRequest
  onResolve: (approved: boolean, alwaysAllow: boolean, feedback?: string, scope?: ApprovalScope, rule?: string) => void
}): React.ReactElement {
  const [feedbackMode, setFeedbackMode] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [ruleMode, setRuleMode] = useState(false)

  useEffect(() => {
    setFeedbackMode(false)
    setFeedback('')
    setRuleMode(false)
  }, [request])

  useInput((input, key) => {
    if (ruleMode) {
      if (input.toLowerCase() === 'y' && request.ruleSuggestion) onResolve(true, false, undefined, 'rule', request.ruleSuggestion)
      else if (input.toLowerCase() === 'n' || key.escape) setRuleMode(false)
      return
    }
    if (feedbackMode) {
      if (key.return) {
        onResolve(false, false, feedback.trim() || undefined)
        return
      }
      if (key.escape) {
        setFeedbackMode(false)
        return
      }
      if (key.backspace || key.delete) {
        setFeedback((f) => f.slice(0, -1))
        return
      }
      if (input && !key.ctrl && !key.meta && input !== '\r' && input !== '\n') {
        setFeedback((f) => f + input)
      }
      return
    }

    if (input === 'y' || input === 'Y') {
      onResolve(true, false)
    } else if (input === 'n' || input === 'N') {
      onResolve(false, false)
    } else if (key.escape) {
      onResolve(false, false)
    } else if (input === 's' || input === 'S') {
      onResolve(true, false, undefined, 'session')
    } else if ((input === 'r' || input === 'R') && request.ruleSuggestion) {
      setRuleMode(true)
    } else if (input === 't' || input === 'T' || key.tab) {
      setFeedbackMode(true)
    }
  })

  const riskColor =
    request.riskLevel === 'dangerous'
      ? 'redBright'
      : request.riskLevel === 'needs-approval'
        ? 'yellowBright'
        : 'greenBright'

  const riskLabel =
    request.riskLevel === 'dangerous'
      ? 'DANGEROUS'
      : request.riskLevel === 'needs-approval'
        ? 'needs approval'
        : 'safe'

  if (ruleMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellowBright" paddingX={1} marginY={1}>
        <Text bold color="yellowBright">Persist this exact approval rule</Text>
        <Text>{formatApprovalDisplay(request.ruleSuggestion ?? '')}</Text>
        <Text dimColor>[y] confirm this rule · [n] back · [ESC] back</Text>
      </Box>
    )
  }

  if (feedbackMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="yellowBright" paddingX={1} marginY={1}>
        <Box>
          <Text bold color="yellowBright">💬 Feedback for denial</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Tell the model what to do differently:</Text>
        </Box>
        <Box marginLeft={2}>
          <Text color="yellowBright">{'>'} {feedback}_</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor> Enter=submit · ESC=back</Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor} paddingX={1} marginY={1}>
      <Box>
        <Text bold color={riskColor}>⚠ Permission Request</Text>
        <Text dimColor> [{riskLabel}]</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color="cyan">{formatApprovalDisplay(request.toolName)}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor wrap="wrap">{formatApprovalDisplay(request.preview)}</Text>
      </Box>
      {request.cwd && <Text dimColor>Directory: {formatApprovalDisplay(request.cwd)}</Text>}
      <Text dimColor>Session approval applies only to this complete operation in this directory under the current settings.</Text>
      <Box marginTop={1}>
        <Text dimColor>
          {' '}
          [y] once · [s] this operation for session · [n] deny · [t] deny with feedback · [ESC] deny
          {request.ruleSuggestion ? ' · [r] review persistent rule' : ''}
        </Text>
      </Box>
    </Box>
  )
}
