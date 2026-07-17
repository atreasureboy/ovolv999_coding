---
name: call-claude
description: Call the locally-installed `claude` CLI (Claude Code, backed by MiniMax-M3) as a secondary agent to write/review code, get a second opinion, or delegate tasks. Use when the user explicitly asks to "use claude", "let M3 do it", "ask claude code", "调用claude", "让claude帮忙", or wants a cross-model comparison. Use ONLY for single-shot or session-resumed delegations; not for interactive pair-programming.
---

# Skill: call-claude

Delegate a task to the locally-installed **Claude Code** CLI (`/usr/local/bin/claude`, v2.1.204), which is wired to the **MiniMax-M3** model. This lets opencode (this session) hand work to a different model and bring the result back.

## When to use

- User explicitly asks to call claude / M3 / claude code.
- User wants a second opinion or cross-model comparison on a piece of code.
- A subtask is better suited to M3's strengths and the user wants delegation.

## When NOT to use

- Interactive, multi-turn pair-programming with the user watching — `claude` is a full TUI and the bash tool cannot drive it interactively.
- Tasks this opencode session can already do faster directly (calling M3 round-trips ~3-30s and costs API tokens on the claude side).

## Verified command shapes (do NOT improvise flags)

All forms below were tested on this machine and work. Stick to these.

### 1. Single-shot, plain text answer

```bash
claude -p "<your prompt here>"
```

- `-p` / `--print` is REQUIRED — without it claude launches the interactive TUI and hangs the bash tool forever.
- Output goes to stdout as plain text.

### 2. Pipe a large prompt via stdin (avoids shell-escaping issues)

```bash
echo "<prompt>" | claude -p
# or from a file:
claude -p < prompt.txt
```

Use this when the prompt contains backticks, quotes, code, or is long.

### 3. Structured JSON output (recommended for parsing results reliably)

```bash
claude -p --output-format json "<prompt>"
```

Returns one JSON object. Useful fields:

| field              | meaning                                            |
| ------------------ | -------------------------------------------------- |
| `result`           | The model's answer text                            |
| `session_id`       | UUID — capture to continue the conversation        |
| `total_cost_usd`   | Dollar cost of this turn                           |
| `usage`            | Token counts                                       |
| `modelUsage`       | Per-model breakdown (confirms `MiniMax-M3`)        |
| `is_error`         | `true` if the call failed                          |

Extract fields with `python3 -c "import sys,json;print(json.load(sys.stdin)['result'])"` or `jq`.

### 4. Multi-turn: resume a previous session

```bash
# turn 1 — capture the session id
SID=$(echo "<prompt 1>" | claude -p --output-format json | \
      python3 -c "import sys,json;print(json.load(sys.stdin)['session_id'])")

# turn 2 — continue in the SAME conversation
claude -p --resume "$SID" "<prompt 2>"
```

`--resume <uuid>` (alias `-r`) keeps full context across turns. Pass `--fork-session` if you want a new session id that copies the history.

### 5. Pin effort / model (optional)

```bash
claude -p --model fable "<prompt>"        # force a specific model alias
claude -p --effort high "<prompt>"        # low|medium|high|xhigh|max
claude -p --max-budget-usd 0.50 "<prompt>" # hard cost ceiling (print mode only)
```

## How to use this skill in practice

1. Confirm intent: if the user's request is ambiguous, ask whether they want opencode to do it directly or delegate to claude.
2. Build the prompt. For code tasks, include: goal, relevant file paths, constraints, and "reply with only the code unless asked otherwise" to keep output tight.
3. Prefer `--output-format json` + stdin piping — it parses cleanly and survives quotes/backticks in the prompt.
4. Always set a generous `timeout` on the bash call (60000–120000 ms). M3 calls typically take 3–30s but can spike.
5. Bring the result back to the user. If claude produced code, read it, sanity-check, and either show it or write it to the target file yourself (do not ask the user to copy-paste).
6. Report cost only if non-trivial (`total_cost_usd` > ~$0.20) or if the user asks.

## Gotchas

- **Never omit `-p`.** Without it, claude opens the TUI and the bash call blocks until timeout.
- **Workspace trust is skipped in print mode.** Only run claude in directories you trust — it can read files and run tools without the usual confirmation dialogs.
- **Cost is real.** Each call bills the claude/M3 account. One typical turn is ~$0.05–$0.15. Avoid calling it in a tight loop; batch work into one prompt.
- **Context is NOT shared.** Claude does not see this opencode session's messages, file reads, or todos. Put everything it needs in the prompt explicitly, or pass file paths and tell it to read them.
- **No tool list = all default tools.** By default claude can read files, run bash, etc. Restrict with `--allowedTools "Read"` or `--disallowedTools "Bash"` if you want it to only think, not act.

## Quick examples

Ask M3 to review a file:

```bash
claude -p --output-format json "Review src/foo.ts for bugs. Be terse." \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['result'])"
```

Get a second opinion on a design decision:

```bash
echo "We are choosing between A (X,Y,Z) and B (X,Y,Z). Which and why? 3 bullets max." \
  | claude -p
```

Hand claude a file to rewrite (it has file tools, so just point it at the path):

```bash
claude -p --allowedTools "Read,Edit" \
  "Refactor src/foo.ts: extract the retry loop into its own function. Then stop."
```
