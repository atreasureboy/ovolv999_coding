/**
 * Banner — startup banner showing version, model, cwd, and git info.
 */

import { Text, Box } from 'ink'

export interface BannerProps {
  version: string
  model: string
  cwd?: string
  gitBranch?: string | null
  contextWindow?: number
}

function shortenPath(p: string, max = 40): string {
  if (p.length <= max) return p
  const parts = p.split('/')
  if (parts.length <= 2) return p
  return '…/' + parts.slice(-2).join('/')
}

export function Banner({ version, model, cwd, gitBranch, contextWindow }: BannerProps): React.ReactElement {
  const ctxStr = contextWindow
    ? contextWindow >= 1000
      ? `${(contextWindow / 1000).toFixed(0)}k`
      : `${contextWindow}`
    : ''

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="magenta">● ovolv999</Text>
        <Text dimColor> v{version}</Text>
      </Box>
      <Box gap={1}>
        <Text dimColor>┤</Text>
        <Text color="cyan">{model}</Text>
        {ctxStr ? <Text dimColor> · {ctxStr} ctx</Text> : null}
        {gitBranch ? <Text color="magenta"> · {gitBranch}</Text> : null}
        <Text dimColor>├</Text>
      </Box>
      {cwd ? (
        <Box>
          <Text dimColor>┤ </Text>
          <Text dimColor italic>{shortenPath(cwd)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
