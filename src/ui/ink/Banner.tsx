/**
 * Banner — startup banner showing version + model.
 */

import { Text, Box } from 'ink'

export function Banner({ version, model }: { version: string; model: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box>
        <Text bold color="magenta">● ovolv999</Text>
        <Text dimColor> v{version}</Text>
      </Box>
      <Box>
        <Text dimColor>┤ </Text>
        <Text color="cyan">{model}</Text>
        <Text dimColor> ├ Think-Act-Observe</Text>
      </Box>
    </Box>
  )
}
