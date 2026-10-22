import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import { isOutcomeReason } from '../outcome.js'
import type { OutcomeReason } from '../outcome.js'

const text = z.string().min(1).max(8192)
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positive = integer.refine(value => value > 0)
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/)
const uuid = z.string().uuid()
const status = z.enum(['completed', 'failed', 'cancelled', 'interrupted', 'limit_reached', 'blocked', 'needs_input'])
const reason = z.custom<OutcomeReason>(isOutcomeReason)
const resources = z.array(text).max(1024)

export const identitySchema = z.object({ workspace: text, sessionId: id, goalHash: text, definitionHash: text })
export const turnSchema = z.object({ threadId: id, turnId: id })
export const terminalSchema = turnSchema.extend({
  finishedSequence: positive,
  historyRevision: integer,
  status,
  reason: z.enum(['max_iterations', 'stop_sequence', 'error', 'interrupted']),
  outcomeReason: reason.optional(),
  unfinishedResources: resources,
})
const stagnationSchema = z.object({ count: integer, fingerprint: text.optional(), artifactVersion: text.optional() })
export const evidenceRefSchema = z.object({
  path: z.string().regex(/^evidence\/[0-9a-f-]{36}-[0-9a-f-]{36}\.json$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: positive.refine(value => value <= 256 * 1024),
  truncated: z.boolean(),
})
export const evidenceSchema = z.object({
  outcomeReason: reason.optional(),
  sufficientForCompletion: z.boolean().optional(),
  status: z.enum(['passed', 'failed', 'not_run', 'not_applicable']),
  workspace: text,
  artifactVersion: text.optional(),
  definitionHash: text.optional(),
  runId: text.optional(),
  commands: z.array(z.object({
    kind: z.enum(['compile', 'lint', 'unit', 'integration', 'task_acceptance']).optional(),
    scope: text.optional(),
    command: z.string(),
    passed: z.boolean(),
    output: z.string(),
    exitCode: z.number().int().nullable(),
    cancelled: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    unfinishedResources: resources.optional(),
  })).max(1024),
  output: z.string(),
  unfinishedResources: resources.optional(),
  failureFingerprint: text.optional(),
  truncated: z.boolean(),
})
export const checkpointSchema = z.object({
  artifactVersion: text,
  evidence: evidenceRefSchema,
  verificationSource: z.enum(['turn', 'loop']),
  stagnation: stagnationSchema,
  decision: z.discriminatedUnion('action', [z.object({ action: z.literal('continue') }), z.object({ action: z.literal('stop'), status, reason: reason.optional(), detail: z.string().max(16384) })]),
  acceptedAt: z.string().datetime().optional(),
})
const attemptSchema = z.object({
  id: uuid,
  ordinal: positive,
  phase: z.enum(['prepared', 'dispatched', 'settled', 'checkpointed']),
  turn: turnSchema.optional(),
  terminal: terminalSchema.optional(),
  checkpoint: checkpointSchema.optional(),
}).superRefine((value, context) => {
  const required = { prepared: [false, false, false], dispatched: [true, false, false], settled: [true, true, false], checkpointed: [true, true, true] }[value.phase]
  if (!isDeepStrictEqual([value.turn !== undefined, value.terminal !== undefined, value.checkpoint !== undefined], required)) context.addIssue({ code: 'custom', message: 'Attempt phase fields disagree' })
  if (value.terminal && (value.terminal.threadId !== value.turn?.threadId || value.terminal.turnId !== value.turn?.turnId)) context.addIssue({ code: 'custom', message: 'Terminal turn identity mismatch' })
})
export const stateSchema = identitySchema.extend({
  schemaVersion: z.literal(1),
  taskId: uuid,
  revision: integer,
  maxIterations: positive,
  stagnationLimit: positive,
  consumedIterations: integer,
  stagnation: stagnationSchema,
  current: attemptSchema.optional(),
  previousCheckpoint: checkpointSchema.optional(),
}).superRefine((value, context) => {
  if (value.consumedIterations > value.maxIterations || (value.consumedIterations === 0) !== !value.current || value.current && value.current.ordinal !== value.consumedIterations || value.revision < value.consumedIterations) context.addIssue({ code: 'custom', message: 'Invalid iteration accounting' })
  if (value.current?.checkpoint && !isDeepStrictEqual(value.stagnation, value.current.checkpoint.stagnation)) context.addIssue({ code: 'custom', message: 'Checkpoint stagnation mismatch' })
  if (value.previousCheckpoint && value.consumedIterations < 2) context.addIssue({ code: 'custom', message: 'Unexpected previous checkpoint' })
})
