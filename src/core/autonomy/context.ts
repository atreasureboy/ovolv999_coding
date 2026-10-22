import { scanForSecrets } from '../../utils/secretScanner.js'
import { eventText } from '../engine/events.js'
import { isOutcomeReason, type VerificationCommandResult, type VerificationEvidence } from '../outcome.js'
import type { OpenAIMessage } from '../types.js'
import { fingerprintFailure } from './continuation.js'
import type { LoopEvidence, LoopEvidenceRef, LoopState } from './types.js'

const evidenceBytes = 256 * 1024 - 1
const contextBytes = 32 * 1024
const marker = '\n[truncated; see source reference]'
const size = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const failed = (command: VerificationCommandResult): boolean => !command.passed || command.exitCode !== 0 || Boolean(command.cancelled || command.timedOut)

function redact(value: string, knownSecrets: readonly string[]): string {
  let result = value
  for (const secret of [...new Set(knownSecrets)].filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(secret).join('[REDACTED]')
  const matches = scanForSecrets(result)
  for (let index = matches.length - 1; index >= 0; index--) {
    const match = matches[index]
    result = result.slice(0, match.start) + '[REDACTED]' + result.slice(match.end)
  }
  return result.replace(/\b(token|password|passwd|api[_-]?key|secret)(["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\]]+)/gi, '$1$2[REDACTED]')
}

function bounded(value: string, bytes: number): { text: string; truncated: boolean } {
  const result = eventText(value, bytes)
  return result.truncated ? { text: eventText(value, Math.max(2, bytes - size(marker) + 2)).text + marker, truncated: true } : result
}

export function sanitizeLoopEvidence(evidence: VerificationEvidence, knownSecrets: readonly string[]): LoopEvidence {
  const failureFingerprint = fingerprintFailure(evidence)
  let truncated = false
  const text = (value: string, bytes = 8192): string => {
    const result = bounded(redact(value, knownSecrets), bytes)
    truncated ||= result.truncated
    return result.text
  }
  const resources = (values: readonly string[]): string[] => {
    truncated ||= values.length > 8
    return values.slice(0, 8).map(value => text(value, 256))
  }
  const reason = evidence.outcomeReason && isOutcomeReason(evidence.outcomeReason) ? evidence.outcomeReason : undefined
  const result: LoopEvidence = {
    status: evidence.status,
    workspace: text(evidence.workspace),
    ...(evidence.artifactVersion !== undefined ? { artifactVersion: text(evidence.artifactVersion) } : {}),
    ...(evidence.definitionHash !== undefined ? { definitionHash: text(evidence.definitionHash) } : {}),
    ...(evidence.runId !== undefined ? { runId: text(evidence.runId) } : {}),
    ...(reason ? { outcomeReason: 'requestId' in reason ? { ...reason, ...(reason.requestId ? { requestId: text(reason.requestId, 256) } : {}) } : { ...reason } } : {}),
    ...(evidence.sufficientForCompletion !== undefined ? { sufficientForCompletion: evidence.sufficientForCompletion } : {}),
    ...(evidence.unfinishedResources ? { unfinishedResources: resources(evidence.unfinishedResources) } : {}),
    ...(failureFingerprint ? { failureFingerprint } : {}),
    commands: [], output: '', truncated: false,
  }
  const accepted: Array<{ index: number; command: VerificationCommandResult }> = []
  const priority = (command: VerificationCommandResult): number => command.cancelled ? 4 : command.unfinishedResources?.length ? 3 : command.timedOut ? 2 : Number(failed(command))
  const ordered = evidence.commands.map((command, index) => ({ command, index })).sort((a, b) => priority(b.command) - priority(a.command))
  for (const { command, index } of ordered) {
    const projected: VerificationCommandResult = {
      command: text(command.command), passed: command.passed, exitCode: command.exitCode, output: text(command.output),
      ...(command.kind ? { kind: command.kind } : {}),
      ...(command.scope !== undefined ? { scope: text(command.scope, 1024) } : {}),
      ...(command.cancelled !== undefined ? { cancelled: command.cancelled } : {}),
      ...(command.timedOut !== undefined ? { timedOut: command.timedOut } : {}),
      ...(command.unfinishedResources ? { unfinishedResources: resources(command.unfinishedResources) } : {}),
    }
    if (result.commands.length >= 1024 || size(result) + size(projected) + 1 > evidenceBytes - 8192) { truncated = true; continue }
    result.commands.push(projected)
    accepted.push({ index, command: projected })
  }
  result.commands = accepted.sort((a, b) => a.index - b.index).map(entry => entry.command)
  result.output = text(evidence.output, Math.min(8192, evidenceBytes - size(result)))
  result.truncated = truncated
  return result
}

export function buildLoopContext(input: {
  state: LoopState; goal: string; acceptance: string; stateNote: string
  previous?: { evidence: LoopEvidence; reference: LoopEvidenceRef }
  artifactChanged: boolean; knownSecrets: readonly string[]
}): { messages: OpenAIMessage[]; prompt: string; truncated: boolean } {
  const messages: OpenAIMessage[] = [{ role: 'system', content: 'Continue the current task using the host acceptance feedback. STATE.md is a non-authoritative note. Completion is determined by independent acceptance.' }]
  const previous = input.previous
  const evidence = previous ? sanitizeLoopEvidence(previous.evidence, input.knownSecrets) : undefined
  let truncated = Boolean(previous?.evidence.truncated || previous?.reference.truncated || evidence?.truncated)
  const text = (value: string, bytes: number): string => {
    const result = bounded(redact(value, input.knownSecrets), bytes)
    truncated ||= result.truncated
    return result.text
  }
  const reference = previous ? `Evidence reference: ${text(previous.reference.path, 2048)}\nsha256: ${text(previous.reference.sha256, 128)}\nbytes: ${previous.reference.bytes}\ntruncated: ${Boolean(previous.evidence.truncated || previous.reference.truncated)}` : 'Evidence reference: none'
  const facts = `Loop attempt: ${input.state.consumedIterations} / ${input.state.maxIterations}\nstagnation: ${input.state.stagnation.count} / ${input.state.stagnationLimit}\nartifactChanged: ${input.artifactChanged}`
  const goal = text(input.goal, 4096)
  const acceptance = text(input.acceptance, 4096)
  const note = text(input.stateNote, 1024)
  const feedback: string[] = []
  let feedbackOmitted = false
  const render = () => `${facts}\n${reference}\nContext truncated: ${truncated}\n\nGoal (.loop/GOAL.md)\n${goal}\n\nAcceptance (.loop/ACCEPTANCE.md)\n${acceptance}\n\nPrevious failed checks\n${feedback.join('\n\n')}${feedbackOmitted ? marker : ''}\n\nNon-authoritative note (.loop/STATE.md)\n${note}`
  for (const command of evidence?.commands.filter(failed) ?? []) {
    const commandText = text(command.command, 1024)
    const prefix = `command: ${commandText}\nexitCode: ${command.exitCode}\noutput: `
    const remaining = contextBytes - size({ messages, prompt: render() }) - size(prefix) - size(marker) - 8
    if (remaining < size(marker) + 2) { truncated = true; feedbackOmitted = true; break }
    const output = bounded(command.output, Math.min(8192, remaining))
    truncated ||= output.truncated
    feedback.push(prefix + output.text)
  }
  return { messages, prompt: render(), truncated }
}
