import { expect, it } from 'vitest'
import { parseAcpArgs } from '../../src/cli/acpArgs.js'

it('parses ACP workspace, model, and session selection', () => {
  expect(parseAcpArgs(['acp', '--cwd', '/workspace', '--model', 'fixture', '--effort', 'high', '--resume', 'previous'])).toEqual({ cwd: '/workspace', model: 'fixture', effort: 'high', resume: 'previous', continueSession: false })
  expect(parseAcpArgs(['acp', '--continue'])).toEqual({ continueSession: true })
})

it.each([
  ['acp', 'task'], ['acp', '--jsonl'], ['acp', '--pipe'], ['acp', '--ink'], ['acp', '--bg'],
  ['acp', '--output-schema', 'schema.json'], ['acp', '--resume', 'session', '--continue'],
  ['acp', '--cwd'], ['acp', '--model', 'one', '--model', 'two'], ['acp', '--effort', 'invalid'],
])('rejects conflicting or unsupported ACP options: %j', (...argv) => {
  expect(() => parseAcpArgs(argv)).toThrow()
})
