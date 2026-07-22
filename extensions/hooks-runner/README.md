# pi-hooks-runner-extension

A configuration-driven **user hook framework** for pi. It bridges pi's
lifecycle events onto Claude Code's JSON hook decision protocol, so hooks you
already wrote for Claude (`hooks.json`, `command` type) run under pi with the
same shapes and semantics.

## Configuration

Two files are read and merged on `session_start`:

- Global: `~/.pi/agent/hooks.json`
- Project: `<cwd>/.pi/hooks.json`

Project matcher blocks are **appended after** global ones per event (both run;
nothing is removed). The Claude settings shape is accepted (a top-level `hooks`
key is optional — a bare event map also works):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "if": "Bash(git *)",
        "hooks": [
          { "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "./scripts/inject-context.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "./scripts/check-done.sh" }] }
    ]
  }
}
```

Malformed JSON, unknown/unbridged event names, and bad hook entries are skipped
with a warning — parsing never throws or blocks startup.

## Event bridge

| pi event                 | Claude hook event  | What a decision can do                                              |
| ------------------------ | ------------------ | ------------------------------------------------------------------- |
| `tool_call`              | `PreToolUse`       | block the call, rewrite `event.input` (`updatedInput`), add context |
| `tool_result`            | `PostToolUse`      | append context to the result, flag it as an error                   |
| `input`                  | `UserPromptSubmit` | transform the prompt (append context) or swallow it (block)         |
| `agent_end`              | `Stop`             | soft-continue the agent once (re-prompt) via `sendUserMessage`      |
| `session_start`          | `SessionStart`     | inject startup context / initial message                            |
| `session_shutdown`       | `SessionEnd`       | fire-and-forget cleanup (never blocks exit)                         |
| `session_before_compact` | `PreCompact`       | cancel compaction on block                                          |

### matcher

- empty / `"*"` / absent → matches everything.
- `Bash`, `Write`, or `Bash|Write|Edit` → exact match on any pipe segment,
  **alias-aware** (pi's lowercase `bash` matches Claude's `Bash` and vice versa).
- anything else → treated as a regular expression (an invalid regex matches
  nothing rather than throwing).

### `if` pre-filter

Optional permission-rule syntax such as `Bash(git *)` gates a matcher block or
an individual hook before the shell is spawned. MVP semantics:

- the rule's tool name must match the event's tool (alias-aware), else the hook
  is filtered out;
- for `Bash`, the command must start with the glob prefix (text before `*`);
- for other tools, a best-effort prefix match against `path` / `file_path` /
  `pattern`; when none is present the hook is allowed to run;
- non-tool events (`Stop`, `SessionStart`, …) ignore `if`.

## Decision protocol

Each hook receives the event JSON on **stdin** (also mirrored in the
`PI_HOOK_INPUT` env var as a fallback) and communicates back via:

- **exit code 2** → block; `stderr` becomes the reason (fed back to the model).
- **stdout JSON** — recognized fields:
  - `continue: false` → block (`stopReason` becomes the reason).
  - `decision: "block"` with `reason`.
  - `systemMessage` → surfaced via a UI notification.
  - `hookSpecificOutput`:
    - `permissionDecision: "deny"` → block (`allow` / `ask` do not block).
    - `updatedInput` → replaces the tool arguments (PreToolUse).
    - `additionalContext` → injected on the next agent turn.
    - `initialUserMessage` → buffered as startup context (SessionStart).
- **stdout that is not JSON** → treated as `additionalContext`.

`PreToolUse` / `SessionStart` `additionalContext` has no direct return channel
in pi, so it is buffered and flushed on the next `before_agent_start` as a
`display: false` message. Oversized hook output is truncated before injection.

## Trust gating

The first time a hook's exact command is about to run, you are asked to confirm
it (`ctx.ui.confirm`). Approving records a SHA-256 of the command via
`appendEntry`, replayed on `session_start` to rebuild the trusted set. Editing
the command changes the hash and re-triggers the prompt. **Without an interactive
UI (print/RPC mode) an untrusted hook is skipped, never auto-run** — a
conservative fail-safe so unattended sessions never execute an unconfirmed
command.

## `/hooks`

Read-only: lists each configured event, its matchers, hook commands, and trust
status.

## Scope / phase 2

- Only `command` hooks execute in this MVP. `prompt`, `agent`, and `http` hook
  types are parsed and listed but skipped at execution time (with a notice) —
  planned for phase 2.
- `Stop` continuation is a soft re-prompt (`sendUserMessage`) guarded by a
  `stop_hook_active` flag against loops; pi has no hard "prevent stop" return.
- `if` conditions do a tool-name + prefix-glob approximation rather than full
  Claude permission-rule evaluation.

## Implementation notes

`index.ts` owns all pi API wiring and side effects (file reads, spawning,
UI, `appendEntry`, the pending-context buffer). All decision logic is in pure
`src/` modules — `config.ts` (parse/merge), `matcher.ts` (matching + `if`),
`protocol.ts` (build input / decode decision), `executor.ts` (spawn-injected
command runner), `trust.ts` (hash/replay). The process spawn is injected, so the
test suite drives the whole bridge with a fake spawn and never runs a real shell.

Because pi's `exec`/`execCommand` cannot pipe stdin, command hooks are run via
`node:child_process.spawn("/bin/sh", ["-c", command])` (precedent:
`extensions/mcp/src/transport.ts`) so the event JSON can be delivered on stdin
per the protocol.
