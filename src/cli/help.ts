import type { Skill } from '../skills/loader.js'
import { Renderer } from '../ui/renderer.js'
import { VERSION, resolveApiEnvironment } from './environment.js'
export function printHelp(skills: Map<string, Skill>): void {
  const r = new Renderer()
  const defaultModel = resolveApiEnvironment().model
  r.banner(VERSION, defaultModel)
  process.stdout.write(`USAGE
  ovolv999 [options] [task]

OPTIONS
  -m, --model <model>       LLM model  (env: OVOGO_MODEL, default: ${defaultModel})
  --max-iter <n>            Think-Act-Observe max cycles  (env: OVOGO_MAX_ITER, default: 200)
  --cwd <path>              Working directory  (env: OVOGO_CWD, default: cwd, supports ~/)
  --loop                    Activate loop mode (reads .loop/ configuration)
  --loop-max-iters <n>      Cap on loop iterations  (env: OVOGO_LOOP_MAX_ITERS, default: 12)
  -c, --continue            Resume the most recent session under <cwd>/sessions/
  -r, --resume <ref>        Resume a specific session by name, prefix, dir, or history.json
  --ink                     Launch with Ink/React UI (full component tree, live autocomplete)
  --pipe                    Pipe mode: read stdin as context, output to stdout (no UI)
  --format <text|json>      Output format for pipe mode (default: text)
  --runtime-status [path]  Inspect retained runs and workspace recovery state
  --recover-workspace <path> --epoch <id> --decision <keep|cancel|continue>
                           Record a recovery decision; stopping confirmation is required
  --confirm-physical-stop  Confirm owned processes have stopped before recovery
  -v, --version             Print version and exit
  -h, --help                Show this help

ENVIRONMENT
  OPENAI_API_KEY            Required for OpenAI-compatible endpoints — API key
  OPENAI_BASE_URL           Optional — compatible endpoint URL
  ANTHROPIC_BASE_URL        Optional — when pointing at api.minimax.io/minimaxi.com/anthropic,
                            MiniMax is auto-detected and ANTHROPIC_AUTH_TOKEN is used
  ANTHROPIC_AUTH_TOKEN      MiniMax API token (replaces OPENAI_API_KEY when MiniMax is active)
  ANTHROPIC_API_KEY         Same as ANTHROPIC_AUTH_TOKEN
  ANTHROPIC_MODEL           Default model override for MiniMax (falls back to OVOGO_MODEL)
  OVOGO_MODEL               Default model when no ANTHROPIC env vars are present
  OVOGO_MAX_ITER            Default for --max-iter
  OVOGO_CWD                 Default for --cwd (supports ~ expansion)
  OVOGO_LOOP_MAX_ITERS      Default for --loop-max-iters
  OVOGO_MAX_CONTEXT_TOKENS  Context window size (default: 200000)
  OVOGO_TEMPERATURE         Sampling temperature
  OVOGO_MAX_OUTPUT_TOKENS   Cap on completion tokens

TOOLS
  Bash          Execute shell commands
  Read          Read file contents
  Write         Write/create files
  Edit          Precise string replacement in files
  Glob          Find files by glob pattern
  Grep          Search file contents with regex
  TodoWrite     Task checklist management
  WebFetch      Fetch URL content as plain text
  WebSearch     Search the web
  Agent         Spawn a sub-agent (preset or custom AgentConfig)
  load_skill    Lazily load a skill's full prompt
  TmuxSession   Manage local interactive processes (tmux)
  ShellSession  Manage inbound persistent shell sessions

REPL COMMANDS
  /plan <task>   Run task in plan mode (read-only analysis + confirm before execute)
  /skills        List available skills
  /<skill> [args] Run a built-in or custom skill
  /sessions      List saved sessions (resume with --continue or --resume)
  /clear         Clear conversation history
  /history       Show message count
  /model         Show current model
  /cwd           Show working directory
  /help          Show this help
  /exit          Exit ovolv999

SKILLS (${skills.size} available)
${[...skills.values()].map((s) => `  /${s.name.padEnd(14)} ${s.description}`).join('\n')}

HOOKS (configure in .ovogo/settings.json)
  PreToolCall       Runs before each tool call   (env: OVOGO_TOOL_NAME, OVOGO_TOOL_INPUT)
  PostToolCall      Runs after each tool call    (env: OVOGO_TOOL_NAME, OVOGO_TOOL_RESULT, OVOGO_TOOL_IS_ERROR)
  UserPromptSubmit  Runs when user submits input (env: OVOGO_PROMPT)
  OnError           Runs on unrecoverable error  (env: OVOGO_ERROR_MESSAGE, OVOGO_TURN_NUMBER)
  OnComplete        Runs when a turn completes   (env: OVOGO_RUN_REASON, OVOGO_RUN_OUTPUT)
  OnContextOverflow Runs after context compaction (env: OVOGO_TOKENS_BEFORE, OVOGO_TOKENS_AFTER)

EXAMPLES
  ovolv999
  ovolv999 "fix the type errors in src/core"
  ovolv999 -m gpt-4o --cwd ~/projects/foo "add unit tests for engine.ts"
  echo "refactor the tool registry" | ovolv999
  ovolv999 --continue                          # resume latest session
  ovolv999 --resume session_2026-07-14_120000  # resume by name
  ovolv999 --loop --loop-max-iters 20          # activate loop mode
`)
}
