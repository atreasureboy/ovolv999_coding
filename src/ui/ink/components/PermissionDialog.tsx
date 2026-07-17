/**
 * PermissionDialog — y/n confirmation for tool execution approval.
 *
 * Shows the tool name, a preview of what it wants to do, and waits for
 * y/n/+ Escape. In auto-approve mode this component is not rendered.
 *
 * The parent (App) passes the pending permission request; this component
 * captures y/n and calls onResolve(approved, alwaysAllow).
 */

import { Text, Box, useInput } from 'ink'

export interface PermissionRequest {
  toolName: string
  preview: string
  riskLevel: 'safe' | 'needs-approval' | 'dangerous'
}

export function PermissionDialog({
  request,
  onResolve,
}: {
  request: PermissionRequest
  onResolve: (approved: boolean, alwaysAllow: boolean) => void
}): React.ReactElement {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onResolve(true, false)
    } else if (input === 'n' || input === 'N' || key.escape) {
      onResolve(false, false)
    } else if (input === 'a' || input === 'A') {
      onResolve(true, true)
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

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={riskColor}
      paddingX={1}
      marginY={1}
    >
      <Box>
        <Text bold color={riskColor}>⚠ Permission Request</Text>
        <Text dimColor> [{riskLabel}]</Text>
      </Box>
      <Box marginTop={1}>
        <Text bold color="cyan">{request.toolName}</Text>
      </Box>
      <Box marginLeft={2}>
        <Text dimColor>{request.preview.slice(0, 100)}</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {' '}
          [y] approve · [n] deny · [a] always allow · [ESC] deny
        </Text>
      </Box>
    </Box>
  )
}
