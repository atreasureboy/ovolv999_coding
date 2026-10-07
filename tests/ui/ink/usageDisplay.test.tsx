import React from 'react'
import { render } from 'ink-testing-library'
import { expect, it } from 'vitest'
import { StatusBar } from '../../../src/ui/ink/components/StatusBar.js'

it('shows unknown cost when requests have no billing evidence', () => {
  const view = render(<StatusBar model="fixture" messageCount={1} contextPct={0} cost={0} apiCalls={1} unknownPriceRequests={1} planMode={false} />)
  expect(view.lastFrame()).toContain('cost unknown')
  expect(view.lastFrame()).not.toContain('$0.0000')
  view.unmount()
})
