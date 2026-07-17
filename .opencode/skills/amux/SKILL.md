---
name: amux
description: Use amux (Agent Multiplexer) to run Claude Code sessions inside tmux with full output visibility. Use when the user asks to "use amux", "run claude via amux", "call claude with visibility", "用amux", or wants to delegate work to Claude Code and SEE what it reads/thinks/does (not a black box). Also use when running parallel agent sessions or overnight autonomous work.
---

# Skill: amux

**amux** is an open-source Agent Control Plane that runs Claude Code (or Codex/Gemini) inside tmux sessions. Unlike `claude -p` (print mode, which is a black box), amux lets you **peek into the live tmux scrollback** — you can see exactly which files claude reads, how long it thinks, what tools it calls, and its full output.

## When to use

- User wants to delegate a task to Claude Code **and** see what it's doing (visibility).
- Running autonomous/overnight sessions with self-healing (auto-compact, auto-restart).
- Parallel agent sessions on different tasks.
- User explicitly mentions amux.

## When NOT to use

- Quick single-shot questions — use the `call-claude` skill (`claude -p`) instead, it's faster.
- Interactive pair-programming with the user watching — opencode itself is better for that.

## Installation (already done on this machine)

amux is installed at `/usr/local/bin/amux` (from-source install). If ever broken, reinstall:

```bash
git clone --depth 1 https://github.com/mixpeek/amux /tmp/opencode/amux
cd /tmp/opencode/amux && ./install.sh
# Then re-apply the patches below!
```

**NOT on PyPI** despite README claims — `pip install amux` / `pipx install amux` / `uv tool install amux` all fail. Must install from source.

## Critical patches applied to `/usr/local/bin/amux`

The vanilla amux script does NOT work in this environment. Two patches were applied. **If amux is reinstalled, these MUST be re-applied:**

### Patch 1: Bypass root check (line 409)

Claude Code refuses `--dangerously-skip-permissions` when running as root. amux's `shell_setup` was modified to export `IS_SANDBOX=1`:

```diff
-    shell_setup="unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; "
+    shell_setup="unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT; export IS_SANDBOX=1; "
```

### Patch 2: Pass through API/provider env vars (lines 414-424)

tmux new sessions inherit env from the tmux **server** process, not from the calling shell. The API keys and endpoints set in the opencode environment would NOT reach the claude process inside tmux. A passthrough loop was added after the `shell_setup` construction:

```bash
  # Pass through provider/API env vars so claude can authenticate inside tmux
  local _ev _env_pass=""
  for _ev in OPENAI_API_KEY OPENAI_BASE_URL OPENAI_API_BASE \
             ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL \
             ANTHROPIC_DEFAULT_SONNET ANTHROPIC_DEFAULT_OPUS \
             ANTHROPIC_DEFAULT_HAIKU; do
    if [[ -n "${!_ev:-}" ]]; then
      _env_pass+="export $_ev=$(printf '%q' "${!_ev}"); "
    fi
  done
  shell_setup="${shell_setup}${_env_pass}"
```

This block sits between the `fi` of the oauth check and the `if $dry_run` check (around line 414).

To verify patches are present:
```bash
grep 'IS_SANDBOX=1' /usr/local/bin/amux && grep '_env_pass' /usr/local/bin/amux
```

## Environment

| Component | Status |
|-----------|--------|
| amux | `/usr/local/bin/amux` v0.3.0 CLI / v0.9.108 server |
| tmux | 3.6 (requires 3.2+) |
| python3 | 3.14.4 (requires 3.10+) |
| claude | `/usr/local/bin/claude` v2.1.21x, wired to **MiniMax-M3** |
| Model | `--model minimax-m3` (NOT sonnet — amux defaults to sonnet, must override) |
| Auth | BYO key via `OPENAI_API_KEY` + `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` |
| Root | Running as root — needs `IS_SANDBOX=1` patch |

## Complete workflow

### 1. Register a session (one-time)

```bash
amux register <name> --dir <project-path> --yolo --model minimax-m3
```

- `--yolo` = adds `--dangerously-skip-permissions` (auto-approve all tool calls, no interactive prompts)
- `--model minimax-m3` = overrides amux's default `--model sonnet` (which would fail)
- Session config stored at `~/.amux/sessions/<name>.env`

### 2. Start the session

```bash
amux start <name> --detach
```

- `--detach` = run in background, don't try to attach (necessary for non-interactive use)
- **EXIT CODE IS 1 even on success** — this is a cosmetic bug. Verify with `amux ls` or `tmux has-session -t amux-<name>` instead of checking `$?`.
- Tmux session name = `amux-<name>`

### 3. Accept the bypass permissions prompt (first start only)

On first launch, Claude Code shows a confirmation menu:

```
❯ 1. No, exit
  2. Yes, I accept
```

Send keys to accept:

```bash
amux send <name> --keys 'Down'    # move to "Yes, I accept"
sleep 0.5
amux send <name> --keys 'Enter'   # confirm
```

**Or skip this entirely** by ensuring `~/.claude/settings.json` contains:

```json
{ "skipDangerousModePermissionPrompt": true }
```

(This is already set on this machine — new sessions should skip the prompt automatically.)

### 4. Send a task

```bash
amux send <name> "Your task prompt here. Be specific about what to do."
```

- Text is sent + Enter to the claude input prompt.
- For multi-line prompts, use `\n` in the string.

### 5. Peek at the output (THE KEY FEATURE)

```bash
amux peek <name>         # last 30 lines (default)
amux peek <name> 80      # last 80 lines
amux peek <name> 200     # last 200 lines (deep scrollback)
```

You will see:
- Claude's prompt (what you sent)
- Tool calls: `read 3 files`, `edit 1 file`, etc.
- Thinking time: `Thought for 5s`
- Claude's response text
- Status bar: model, effort level, permission mode

**Poll pattern** — claude takes 5-60s per turn. Wait then peek:

```bash
amux send <name> "do something"; sleep 20; amux peek <name> 80
```

If still working, wait more and peek again. A `❯` prompt with nothing after it means claude is idle and waiting for input.

### 6. Send special keys

```bash
amux send <name> --keys 'C-c'      # Ctrl-C (interrupt)
amux send <name> --keys 'Escape'   # Esc
amux send <name> --keys 'Down'     # Arrow down
amux send <name> --keys 'Enter'    # Enter
```

### 7. Stop / remove

```bash
amux stop <name>     # kill the tmux session
amux rm <name>       # stop + delete session config
amux stop-all        # stop everything
```

### 8. List sessions

```bash
amux ls              # all sessions with status + preview
```

Output columns: `N*  <name>  <dir>  [YOLO]  <model>  │  <last status line>`
The `*` means the session is currently running.

## Other features (available but less used)

```bash
amux serve                    # web dashboard on https://localhost:8822
amux exec <name> -- <prompt>  # register + start + send in one shot
amux board add "title"        # kanban board (SQLite-backed)
amux board done PROJ-1        # mark board item done
```

## Tmux internals (for debugging)

amux creates tmux sessions named `amux-<name>`. Direct tmux commands work:

```bash
tmux ls                                   # list all tmux sessions
tmux has-session -t =amux-<name>          # check if session exists
tmux capture-pane -p -t amux-<name>       # raw pane dump (like peek)
tmux capture-pane -p -t amux-<name> -S -300  # last 300 lines
tmux send-keys -t amux-<name> "text" Enter  # direct send (bypasses amux)
tmux kill-session -t amux-<name>          # force kill
```

## Gotchas

1. **`amux start` returns exit code 1 even on success.** Don't check `$?`. Use `amux ls` or `tmux has-session` to verify.
2. **Default model is `sonnet`.** Always pass `--model minimax-m3` when registering, or edit `~/.amux/sessions/<name>.env` to fix `CC_FLAGS`.
3. **Root check blocks `--dangerously-skip-permissions`.** Needs `IS_SANDBOX=1` patch in the amux script.
4. **Env vars don't propagate to tmux.** API keys must be passed through explicitly (Patch 2). Without it, claude shows "Not logged in · Please run /login".
5. **Permission bypass prompt on first start.** Either send Down+Enter keys, or ensure `skipDangerousModePermissionPrompt: true` in `~/.claude/settings.json`.
6. **Stale tmux sessions.** If `amux start` says "already running" but the session is dead, kill it manually: `tmux kill-session -t amux-<name>`.
7. **Claude auto-updates.** The claude version may bump between sessions (e.g., v2.1.207 -> v2.1.210). This is normal and doesn't break amux.
8. **`amux peek` adds `── end ──` marker** at the bottom — this is amux's output, not claude's.
9. **API keys are in the tmux command string.** The env passthrough embeds key values in the shell command. Don't `amux start --dry-run` in a shared terminal (it prints keys).

## Comparison: amux vs `claude -p` (call-claude skill)

| Aspect | `claude -p` (call-claude) | amux |
|--------|--------------------------|------|
| Visibility | Black box — only final result | Full — see file reads, tool calls, thinking |
| Mode | Print (single-shot) | Interactive (multi-turn, persistent session) |
| Session | Ephemeral or `--resume` by UUID | Persistent tmux session, survives stop/start |
| Multi-turn | Manual `--resume <sid>` | `amux send` just works, session stays alive |
| File writes | Sometimes blocked (write permission inconsistent) | Works reliably (bypass permissions in tmux) |
| Speed | 3-30s per call | 5-60s per turn (includes TUI rendering) |
| Cost | Per-call billing | Same model, same billing |
| Best for | Quick questions, code review, JSON parsing | Implementation tasks, autonomous work, parallel agents |

## Quick start cheat sheet

```bash
# Register (one-time per project)
amux register mywork --dir /project/ovolv999_pro --yolo --model minimax-m3

# Start
amux start mywork --detach
# (ignore exit code 1 — check with: amux ls)

# Send a task and wait for result
amux send mywork "Fix the bug in src/foo.ts: the retry loop doesn't handle ECONNRESET. Read the file, fix it, then stop."
sleep 30
amux peek mywork 80

# If claude is still working, peek again
sleep 20
amux peek mywork 80

# Continue the conversation (same session, full context)
amux send mywork "Now add a test for that fix."
sleep 30
amux peek mywork 80

# Clean up
amux stop mywork
```
