/**
 * StatusBar — compact info bar at the bottom showing model, context pressure,
 * cost, and plan mode.
 */

import { Text, Box } from 'ink'

export interface StatusBarProps {
  model: string
  messageCount: number
  contextPct: number // 0..1
  cost: number
  planMode: boolean
}

export function StatusBar({ model, messageCount, contextPct, cost, planMode }: StatusBarProps): React.ReactElement {
  const pct = Math.round(contextPct * 100)
  const ctxColor = pct > 85 ? 'red' : pct > 60 ? 'yellow' : 'green'

  return (
    <Box justifyContent="space-between" marginTop={1}>
      <Box gap={1}>
        <Text dimColor>{model}</Text>
        {planMode ? <Text color="blueBright">◆ PLAN</Text> : null}
        <Text dimColor>· {messageCount} msgs</Text>
      </Box>
      <Box gap={1}>
        <Text color={ctxColor}>ctx {pct}%</Text>
        <Text dimColor>${cost.toFixed(4)}</Text>
      </Box>
    </Box>
  )
}
