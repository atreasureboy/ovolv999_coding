/**
 * SelectPicker — arrow-key navigable selection list.
 *
 * Generic component for choosing from a list of items. Used by:
 * - /resume interactive session selection
 * - /model model switching
 * - Any future picker UI
 *
 * Keyboard:
 *   ↑/↓     Navigate
 *   Enter   Select
 *   ESC     Cancel
 *
 * The highlighted item is visually distinct (inverse video).
 */

import { Text, Box, useInput } from 'ink'
import { useState, useEffect } from 'react'

export interface SelectPickerItem<T = unknown> {
  label: string
  description?: string
  value: T
}

export function SelectPicker<T>({
  items,
  title,
  onSelect,
  onCancel,
}: {
  items: SelectPickerItem<T>[]
  title: string
  onSelect: (value: T) => void
  onCancel: () => void
}): React.ReactElement {
  const [selected, setSelected] = useState(0)

  // Reset selection when items change
  useEffect(() => {
    setSelected(0)
  }, [items.length])

  useInput((_input, key) => {
    if (items.length === 0) return
    if (key.upArrow) {
      setSelected((s) => (s - 1 + items.length) % items.length)
    } else if (key.downArrow) {
      setSelected((s) => (s + 1) % items.length)
    } else if (key.return) {
      onSelect(items[selected].value)
    } else if (key.escape) {
      onCancel()
    }
  })

  if (items.length === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text bold color="cyan">{title}</Text>
        <Text dimColor> No items to choose from.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text bold color="cyan">{title}</Text>
      <Text dimColor> ↑↓ navigate · Enter select · ESC cancel</Text>
      {items.map((item, i) => (
        <Box key={i}>
          <Text color={i === selected ? 'black' : undefined} backgroundColor={i === selected ? 'cyan' : undefined}>
            {' '}
            {i === selected ? '▸' : ' '} {item.label}{' '}
          </Text>
          {item.description ? (
            <Text dimColor> {item.description}</Text>
          ) : null}
        </Box>
      ))}
    </Box>
  )
}
