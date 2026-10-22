import { expect, it } from 'vitest'
import { buildLoopContext, sanitizeLoopEvidence } from '../../../src/core/autonomy/context.js'
import { fingerprintFailure } from '../../../src/core/autonomy/continuation.js'
import type { LoopEvidence, LoopState } from '../../../src/core/autonomy/types.js'
import type { VerificationEvidence } from '../../../src/core/outcome.js'

const state: LoopState = { schemaVersion: 1, taskId: 'task', workspace: 'workspace', sessionId: 'session', goalHash: 'goal', definitionHash: 'definition', revision: 1, maxIterations: 12, stagnationLimit: 3, consumedIterations: 2, stagnation: { count: 1 } }
const reference = { path: 'evidence/previous-check.json', sha256: 'a'.repeat(64), bytes: 400, truncated: false }
function evidence(output = '中文 failure 🚀'): VerificationEvidence {
  return { status: 'failed', workspace: 'workspace', artifactVersion: 'artifact', definitionHash: 'definition', output, commands: [{ command: 'npm test', passed: false, exitCode: 1, output }] }
}
function context(previous?: LoopEvidence) {
  return { state, goal: 'Fix the bug', acceptance: 'npm test passes', stateNote: 'I think it works', artifactChanged: false, knownSecrets: [] as string[], ...(previous ? { previous: { evidence: previous, reference: { ...reference, truncated: previous.truncated } } } : {}) }
}

it('projects task facts and failed receipts with explicit labels and references, without internal state', () => {
  const input = context(sanitizeLoopEvidence(evidence(), []))
  const tainted = Object.assign(input, { history: [{ reasoning_content: 'hidden', providerState: 'hidden' }] })
  Object.assign(tainted.state, { providerState: 'hidden' })
  Object.assign(tainted.previous!.evidence.commands[0], { reasoning_content: 'hidden' })
  const result = buildLoopContext(tainted)
  const serialized = JSON.stringify(result)
  expect(serialized).toContain('Fix the bug')
  expect(serialized).toContain('command: npm test')
  expect(serialized).toContain('exitCode: 1')
  expect(serialized).toContain('output: 中文 failure 🚀')
  expect(serialized).toContain(reference.path)
  expect(serialized).toContain('2 / 12')
  expect(serialized).toContain('artifactChanged: false')
  expect(serialized).toContain('non-authoritative')
  expect(serialized).not.toMatch(/providerState|reasoning_content|hidden/)
  expect(result.truncated).toBe(false)
})

it('redacts whole strings before cutting across a credential boundary and whitelists evidence fields', () => {
  const secret = 'actual-model-credential-1234567890'
  const original = evidence('x'.repeat(8180) + secret + ' password="tiny value" token=short sk-' + 'a'.repeat(40))
  original.commands[0].command = `check --token=${secret}`
  Object.assign(original, { providerState: { secret }, reasoning_content: secret })
  const result = sanitizeLoopEvidence(original, [secret])
  expect(result.failureFingerprint).toBe(fingerprintFailure(original))
  const serialized = JSON.stringify(result)
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain('tiny value')
  expect(serialized).not.toContain('token=short')
  expect(serialized).not.toContain('sk-' + 'a'.repeat(40))
  expect(serialized).not.toMatch(/providerState|reasoning_content/)
  expect(result.truncated).toBe(true)
  expect(Buffer.byteLength(result.commands[0].output)).toBeLessThanOrEqual(8192)
  expect(original.commands[0].output).toContain(secret)
})

it('bounds UTF-8 evidence, prioritizes failure output and preserves a pre-truncation fingerprint', () => {
  const raw = evidence('中文🚀'.repeat(20000))
  raw.commands = Array.from({ length: 100 }, (_, index) => ({ command: `check-${index}` + 'z'.repeat(10000), passed: index < 99, exitCode: index < 99 ? 0 : 1, output: index < 99 ? 'success'.repeat(10000) : 'IMPORTANT FAILURE ' + '中文🚀'.repeat(20000) }))
  const result = sanitizeLoopEvidence(raw, [])
  expect(Buffer.byteLength(JSON.stringify(result) + '\n')).toBeLessThanOrEqual(262144)
  expect(result.commands.some(command => command.output.includes('IMPORTANT FAILURE'))).toBe(true)
  expect(result.commands.every(command => Buffer.byteLength(command.output) <= 8192)).toBe(true)
  expect(JSON.stringify(result)).not.toContain('\ufffd')
  expect(result.failureFingerprint).toBe(fingerprintFailure(raw))
  expect(result.truncated).toBe(true)
})

it('bounds the complete JSON model context for multibyte diagnostics, escaped commands and task files', () => {
  const secret = 'credential-on-boundary-123456789'
  const input = context(sanitizeLoopEvidence(evidence('中文🚀"\\\n'.repeat(20000)), []))
  input.goal = '目标中文🚀'.repeat(20000) + secret
  input.acceptance = 'acceptance'.repeat(10000)
  input.stateNote = 'notes'.repeat(20000)
  input.knownSecrets = [secret]
  input.previous!.evidence.commands[0].command = 'command"\\\n'.repeat(10000)
  const result = buildLoopContext(input)
  const serialized = JSON.stringify({ messages: result.messages, prompt: result.prompt })
  expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(32768)
  expect(serialized).toContain(reference.path)
  expect(serialized).toContain('.loop/GOAL.md')
  expect(serialized).toContain('.loop/ACCEPTANCE.md')
  expect(serialized).toContain('.loop/STATE.md')
  expect(serialized).toContain('truncated')
  expect(serialized).toContain('output:')
  expect(serialized).not.toContain(secret)
  expect(serialized).not.toContain('\ufffd')
  expect(result.truncated).toBe(true)
})

it('uses failure diagnostics before verbose successful checks in the next model window', () => {
  const raw = evidence()
  raw.commands.unshift({ command: 'successful-check', exitCode: 0, passed: true, output: 'success'.repeat(10000) })
  const result = buildLoopContext(context(sanitizeLoopEvidence(raw, [])))
  expect(result.prompt).toContain('output: 中文 failure 🚀')
  expect(result.prompt).not.toContain('success'.repeat(100))
})

it('redacts task text, notes, references and labelled short credentials', () => {
  const input = context(sanitizeLoopEvidence(evidence('password: hunter2 token="a b c"'), []))
  input.goal = 'known-model-secret'
  input.acceptance = 'password=short'
  input.stateNote = 'token: short'
  input.knownSecrets = ['known-model-secret']
  const result = JSON.stringify(buildLoopContext(input))
  expect(result).not.toContain('known-model-secret')
  expect(result).not.toContain('hunter2')
  expect(result).not.toContain('a b c')
  expect(result).not.toContain('password=short')
  expect(result).not.toContain('token: short')
})

it('keeps dense short failures inside the full JSON budget with an evidence reference', () => {
  const raw = evidence()
  raw.commands = Array.from({ length: 1024 }, (_, index) => ({ command: `check-${index}`, passed: false, exitCode: 1, output: `failure-${index}` }))
  const result = buildLoopContext(context(sanitizeLoopEvidence(raw, [])))
  expect(Buffer.byteLength(JSON.stringify({ messages: result.messages, prompt: result.prompt }))).toBeLessThanOrEqual(32768)
  expect(result.prompt).toContain(reference.path)
  expect(result.prompt).toContain('failure-0')
  expect(result.truncated).toBe(true)
})

it('preserves stop receipts ahead of ordinary failure output when evidence must be cut', () => {
  const raw = evidence()
  raw.commands = Array.from({ length: 100 }, (_, index) => ({ command: `check-${index}`, passed: false, exitCode: 1, output: 'x'.repeat(10000) }))
  raw.commands.push({ command: 'cancelled-check' + 'z'.repeat(10000), passed: false, exitCode: null, cancelled: true, output: 'cancelled'.repeat(10000) })
  const result = sanitizeLoopEvidence(raw, [])
  expect(result.commands.some(command => command.cancelled)).toBe(true)
  expect(result.truncated).toBe(true)
})
