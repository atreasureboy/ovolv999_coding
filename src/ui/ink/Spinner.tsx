/**
 * Spinner — animated loading indicator with rotating verb.
 * Uses Ink's useInterval pattern (state + useEffect timer).
 */

import { Text, Box } from 'ink'
import { useState, useEffect } from 'react'

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function Spinner({
  active,
  verb,
}: {
  active: boolean
  verb: string
}): React.ReactElement | null {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length)
    }, 60)
    return () => clearInterval(timer)
  }, [active])

  if (!active) return null

  return (
    <Box>
      <Text color="magenta">{FRAMES[frame]}</Text>
      <Text dimColor> {verb}...</Text>
    </Box>
  )
}
