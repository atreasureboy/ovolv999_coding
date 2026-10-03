# Module refinement design

## Intent

Refine this TypeScript coding agent module by module so its execution paths and ownership boundaries are easy to understand. The user permits removing genuinely redundant functionality and asks for comparison with official Codex. Preserve active commands, permissions, cancellation, outcome verification, process ownership and history compatibility unless a specific defect is reproduced.

## Reference and approach

Official references inspected on 2026-10-03:

- [Codex app server](https://learn.chatgpt.com/docs/app-server): frontend interaction uses thread, turn and item lifecycles.
- [Tool router](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/router.rs): model-visible tool plans have an explicit owner.
- [Tool orchestrator](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/orchestrator.rs): approval and execution boundaries are centralized.
- [Parallel tool runtime](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/parallel.rs): concurrency follows tool capabilities and cancellation has its own lifecycle.

Apply those responsibility boundaries to the existing TypeScript application. Retain its compatible model transport and persistence protocols. Wholesale Rust migration, universal service containers and a new plugin framework would add unrelated work. Cosmetic reformatting would not address the implementation complexity.

## Boundaries

- `core/engine.ts` owns a turn and coordinates modules, policies, model requests, tool execution and acceptance. Extract cohesive stream parsing, tool output budgeting, tool policy and final acceptance. A core-owned observer contract describes display events without importing the terminal implementation.
- `cli/` owns argument and environment resolution, session path validation, help and session subcommands. `bin/ovogogogo.ts` remains the entry composition and preserves its exported helper names.
- `commands/*Commands.ts` contains nine explicit command groups. A single assembly in `commands/builtin.ts` registers each active command once. Remove only shadowed duplicate handlers after pinning the effective behavior and order.
- `ui/ink/replController.ts` owns conversation state and actions. `runInkRepl.ts` composes rendering and cleanup. Slash commands must see the current conversation.
- File tools share path preparation, backup and atomic-write primitives; tool-specific stale-file checks retain their ordering. Bash output collection is separate from process termination.
- Provider metadata, detection and capability lookup have separate responsibilities. Settings normalization, layering and patching are separate from persistence. ACP framing is separate from protocol dispatch and execution ownership.
- Later passes examine remaining runtime, persistence, modules, utilities and UI code. Stable modules stay intact when an additional abstraction would make them harder to follow. Record examined-but-unchanged domains honestly.

## Verification and deletion rules

The baseline is HEAD `d6e3e9c49640b63b6f3a6e5a47df76c1911b6750`, clean checkout. Fresh baseline: typecheck and lint pass; 172 test files pass, 3672 tests pass and 14 skip. Use the existing suite for behavior-preserving refactors and add characterization tests for exposed boundaries. Reproduce behavioral defects before fixing them. Do not remove assertions or relax limits to obtain green checks.

No new dependencies, code comments, schema migrations or broad filesystem cleanup. Preserve exported module paths where callers rely on them. Removal requires evidence of a shadowed registration, unreachable branch or redundant private implementation; an absence of tests alone is insufficient. Each domain reports actual changes, tests and remaining concerns. Finish with independent diff review, full typecheck/lint/tests, clean build and installed CLI acceptance.
