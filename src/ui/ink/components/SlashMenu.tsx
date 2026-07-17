/**
 * SlashMenu — live slash command suggestions.
 *
 * Displays a filtered list of commands + skills below the input prompt.
 * Arrow keys navigate, Tab/Enter selects (autocompletes the input).
 *
 * This replaces the ANSI-overlay SlashSuggester with a proper Ink component.
 */

import { Text, Box } from 'ink'

export interface SlashEntry {
  name: string
  description: string
  kind: 'cmd' | 'skill'
}

export function SlashMenu({
  entries,
  selected,
}: {
  entries: SlashEntry[]
  selected: number
}): React.ReactElement {
  if (entries.length === 0) return <></>

  const maxName = Math.max(...entries.map((e) => e.name.length), 4)

  return (
    <Box flexDirection="column" marginTop={0}>
      {entries.map((entry, i) => {
        const isSel = i === selected
        return (
          <Box key={`${entry.kind}-${entry.name}`}>
            <Text color={isSel ? 'black' : 'cyan'} backgroundColor={isSel ? 'cyan' : undefined}>
              {' '}
              /{entry.name.padEnd(maxName)}{' '}
            </Text>
            <Text dimColor> {entry.description}</Text>
            {entry.kind === 'skill' ? <Text dimColor italic> (skill)</Text> : null}
          </Box>
        )
      })}
    </Box>
  )
}
