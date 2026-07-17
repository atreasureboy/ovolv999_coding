/**
 * FileSuggestMenu — dropdown list of file path suggestions for @-mentions.
 *
 * Renders matching files/directories with a highlight on the selected item.
 * Directories are shown with a trailing / and cyan color.
 */

import { Text, Box } from 'ink'
import type { FileSuggestion } from '../fileSuggest.js'

export function FileSuggestMenu({
  suggestions,
  selected,
  query,
}: {
  suggestions: FileSuggestion[]
  selected: number
  query: string
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginLeft={2} marginY={0}>
      {suggestions.map((s, i) => (
        <Box key={i}>
          <Text color={i === selected ? 'black' : undefined} backgroundColor={i === selected ? 'blue' : undefined}>
            {' '}{i === selected ? '▸' : ' '}{' '}
          </Text>
          <Text color={s.isDir ? 'cyanBright' : undefined} backgroundColor={i === selected ? 'blue' : undefined}>
            {s.label}
          </Text>
        </Box>
      ))}
      <Text dimColor> ↑↓ navigate · Tab/Enter select · {suggestions.length} match{suggestions.length !== 1 ? 'es' : ''} for "@{query}"</Text>
    </Box>
  )
}
