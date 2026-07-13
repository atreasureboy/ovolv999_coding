/**
 * AskUserQuestion Tool — let the Agent ask the user clarifying questions
 *
 * Inspired by Claude Code's AskUserQuestionTool.
 *
 * During execution, the Agent may need to:
 *   1. Clarify ambiguous instructions
 *   2. Get a decision on implementation choices
 *   3. Offer the user choices about direction
 *
 * This tool pauses the LLM loop, displays a multiple-choice prompt to the
 * user, and returns their selection. The user can always pick "Other" to
 * type a custom answer.
 *
 * Architecture: The tool itself is stateless — it calls a callback
 * (`ctx.askUserQuestion`) provided by the REPL. This keeps the tool
 * testable (mock the callback) and decoupled from the terminal I/O layer.
 *
 * IMPORTANT — single readline ownership: the terminal handler in this file
 * is given a `SharedPrompt` by the REPL and routes ALL input through it.
 * It does NOT create a second `readline.createInterface` on stdin. Doing
 * so would race the REPL's readline and corrupt user input. This is the
 * single biggest source of "my prompt got eaten" bugs in CLI tools.
 *
 * Non-TTY / piped mode (SharedPrompt.isTTY === false): the handler
 * returns a graceful fallback answer ("Other (auto)") instead of
 * blocking on a stdin that nobody is typing into. The LLM then proceeds
 * with best judgment, which is what the user implicitly asked for when
 * they piped input.
 */

import type {
  Tool,
  ToolContext,
  ToolDefinition,
  ToolResult,
  AskUserOption,
  AskUserQuestionInput,
  AskUserQuestionHandler,
} from '../core/types.js'
import type { SharedPrompt } from '../ui/input.js'

// Re-export for convenience (terminal handler consumers import from here)
export type { AskUserOption, AskUserQuestionInput, AskUserQuestionHandler }

// ── Validation ──────────────────────────────────────────────────────────────

interface RawQuestion {
  question?: unknown
  header?: unknown
  options?: unknown
  multiSelect?: unknown
}

interface RawOption {
  label?: unknown
  description?: unknown
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function validateQuestions(questions: unknown): string | null {
  if (!Array.isArray(questions) || questions.length === 0) {
    return 'questions must be a non-empty array (1-4 questions)'
  }
  if (questions.length > 4) {
    return 'Maximum 4 questions allowed'
  }

  const seenQuestions = new Set<string>()
  for (const rawQ of questions) {
    if (!isObject(rawQ)) return 'Each question must be an object'
    const q = rawQ as RawQuestion
    if (typeof q.question !== 'string' || !q.question) {
      return 'Each question must have a non-empty "question" string'
    }
    if (typeof q.header !== 'string' || !q.header) {
      return 'Each question must have a non-empty "header" string'
    }
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) {
      return `Question "${q.question}" must have 2-4 options`
    }
    if (seenQuestions.has(q.question)) {
      return `Duplicate question: "${q.question}"`
    }
    seenQuestions.add(q.question)

    const seenLabels = new Set<string>()
    for (const rawOpt of q.options) {
      if (!isObject(rawOpt)) return `Option in question "${q.question}" must be an object`
      const opt = rawOpt as RawOption
      if (typeof opt.label !== 'string' || !opt.label) {
        return `Option in question "${q.question}" must have a non-empty "label"`
      }
      if (seenLabels.has(opt.label)) {
        return `Duplicate option label "${opt.label}" in question "${q.question}"`
      }
      seenLabels.add(opt.label)
    }
  }
  return null
}

// ── Tool ────────────────────────────────────────────────────────────────────

export class AskUserQuestionTool implements Tool {
  name = 'AskUserQuestion'
  metadata = { mutatesState: true, concurrencySafe: false }

  definition: ToolDefinition = {
    type: 'function',
    function: {
      name: 'AskUserQuestion',
      description: `Ask the user multiple-choice questions to gather information, clarify ambiguity, or get decisions. The user can always select "Other" to type a custom answer.

## When to Use
- Clarify ambiguous instructions before starting work
- Get a decision on implementation choices (e.g., "Which library?" "Which approach?")
- Offer the user choices about direction
- Gather preferences or requirements

## When NOT to Use
- The answer is obvious from context — just proceed
- You can determine the answer by reading files — use Read instead
- Asking "should I proceed?" — just proceed if confident

## Question Fields
- question: The full question text (must end with "?")
- header: Very short label (max 12 chars, e.g., "Auth method", "Library")
- options: 2-4 choices, each with:
  - label: Short display text (1-5 words)
  - description: Explanation of what this option means
- multiSelect: Set true to allow multiple selections (default: false)

## Tips
- If you recommend an option, make it first and add "(Recommended)" to the label
- 2-3 options is usually best — don't overwhelm the user
- "Other" is always available — don't add it as an explicit option`,
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: '1-4 questions to ask the user',
            minItems: 1,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                question: {
                  type: 'string',
                  description: 'The complete question to ask (end with "?")',
                },
                header: {
                  type: 'string',
                  description: 'Very short label (max 12 chars)',
                },
                options: {
                  type: 'array',
                  description: '2-4 options (do NOT include "Other" - it is automatic)',
                  minItems: 2,
                  maxItems: 4,
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'Short display text (1-5 words)' },
                      description: { type: 'string', description: 'What this option means' },
                    },
                    required: ['label', 'description'],
                  },
                },
                multiSelect: {
                  type: 'boolean',
                  description: 'Allow multiple selections (default: false)',
                },
              },
              required: ['question', 'header', 'options'],
            },
          },
        },
        required: ['questions'],
      },
    },
  }

  isConcurrencySafe(): boolean {
    return false // Requires user interaction — must not run in parallel
  }

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const questionsRaw = input.questions
    const error = validateQuestions(questionsRaw)
    if (error) {
      return { content: `Error: ${error}`, isError: true }
    }

    const questions = questionsRaw as AskUserQuestionInput[]

    // No callback available — sub-agent or piped mode
    if (!ctx.askUserQuestion) {
      // Graceful fallback: return a note so the LLM can proceed with best judgment
      const questionTexts = questions.map((q) => q.question).join('; ')
      return {
        content: `Unable to ask the user (non-interactive mode). Questions were: "${questionTexts}". Proceed with your best judgment based on available context.`,
        isError: false,
      }
    }

    try {
      // Forward ctx.signal so the prompt is cancelled when the engine
      // is aborted (ESC / hard deadline / 2nd SIGINT). Without this,
      // a pending question would block the readline indefinitely and
      // continue consuming stdin even after the engine wanted to
      // abort the turn.
      const answers = await ctx.askUserQuestion(questions, ctx.signal)

      // Format answers for the LLM
      const formatted = Object.entries(answers)
        .map(([q, a]) => `Q: ${q}\nA: ${a}`)
        .join('\n\n')

      return {
        content: `The user answered your questions:\n\n${formatted}`,
        isError: false,
      }
    } catch (err) {
      return {
        content: `Failed to get user response: ${(err as Error).message}`,
        isError: true,
      }
    }
  }
}

// ── Terminal handler factory ────────────────────────────────────────────────
//
// Creates an AskUserQuestionHandler backed by a REPL-owned readline.
// The REPL is responsible for instantiating ONE InputHandler; this
// factory binds the handler to that handler's SharedPrompt so we never
// spawn a competing readline interface on stdin.

export interface TerminalAskUserDeps {
  /** Shared prompt bound to the REPL's readline (see InputHandler.sharedPrompt). */
  prompt: SharedPrompt
  /** Output sink — typically `(s) => process.stdout.write(s)`. */
  writeOut: (s: string) => void
}

export function createTerminalAskUserHandler(
  deps: TerminalAskUserDeps,
): AskUserQuestionHandler {
  const { prompt, writeOut } = deps
  return async (questions: AskUserQuestionInput[], signal?: AbortSignal): Promise<Record<string, string>> => {
    // Non-TTY (pipe, redirect, sub-agent): return the synthetic "Other (auto)"
    // answer for every question. This is what the LLM would have seen if the
    // tool had no callback at all — but here we keep the per-question keys so
    // the LLM's prompt can still reason about which questions were skipped.
    if (!prompt.isTTY) {
      const fallback: Record<string, string> = {}
      for (const q of questions) {
        fallback[q.question] = 'Other (auto — non-interactive mode)'
      }
      return fallback
    }

    const answers: Record<string, string> = {}
    for (const q of questions) {
      // Honour an external abort between questions too: if the engine
      // aborted between two questions, we should not keep prompting.
      if (signal?.aborted) {
        answers[q.question] = 'Other (aborted)'
        continue
      }

      const multi = q.multiSelect === true
      const header = q.header.slice(0, 12)
      const promptLabel = multi
        ? `  ❯❯ [${header}] ${q.question} (comma-separated numbers)\n`
        : `  ❯❯ [${header}] ${q.question}\n`

      writeOut('\n' + promptLabel)
      q.options.forEach((opt, i) => {
        writeOut(`      ${i + 1}. ${opt.label} — ${opt.description}\n`)
      })
      writeOut(`      0. Other (type your own answer)\n`)

      // Drive the REPL's owned readline — never call readline.createInterface
      // here. Forward the abort signal so a Ctrl+C / deadline / 2nd-SIGINT
      // cancels the in-flight question immediately rather than letting
      // it block the readline.
      const { text: resp, eof, aborted } = await prompt.readLine('  ❯ ', signal)
      if (aborted) {
        // External abort (e.g. hard deadline fired) — fill remaining
        // questions with a sentinel answer and bail out of the loop.
        answers[q.question] = 'Other (aborted)'
        for (const rest of questions.slice(questions.indexOf(q) + 1)) {
          answers[rest.question] = 'Other (aborted)'
        }
        return answers
      }
      if (eof) {
        answers[q.question] = 'Other (Ctrl+D — no answer)'
        continue
      }
      const answer = resp.trim()

      // Parse the response
      if (multi) {
        const selections = answer
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
        const labels: string[] = []
        for (const sel of selections) {
          const idx = parseInt(sel, 10)
          if (!isNaN(idx) && idx >= 1 && idx <= q.options.length) {
            labels.push(q.options[idx - 1].label)
          } else if (sel === '0' || isNaN(idx)) {
            // "0" or non-numeric → treat as custom text
            if (sel !== '0') labels.push(sel)
          }
        }
        answers[q.question] = labels.length > 0 ? labels.join(', ') : answer
      } else {
        const idx = parseInt(answer, 10)
        if (!isNaN(idx) && idx >= 1 && idx <= q.options.length) {
          answers[q.question] = q.options[idx - 1].label
        } else {
          // Non-numeric or "0" → custom text
          answers[q.question] = answer
        }
      }
    }
    return answers
  }
}
