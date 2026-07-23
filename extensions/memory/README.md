# pi-memory-extension

Claude Code-style automatic long-term memory for Pi.

The extension scopes memory to the current git root, initializes it silently, injects the
index and relevant topics into context, and conservatively distills durable facts after a
turn. Users do not need to run `/memory init` or `/remember` for memory to work; those
commands remain useful for inspection and explicit correction.

## Automatic lifecycle

1. `session_start`（涵盖 startup/reload/new/resume/fork）解析当前作用域，并在缺失时创建
   `MEMORY.md`。
2. `before_agent_start` injects the index/rules once per context window and recalls relevant
   topic bodies on demand.
3. `turn_end` inspects only the latest user/assistant exchange. A local signal gate skips
   ordinary turns; qualifying turns use the current model for a small structured extraction.
4. Extracted facts are merged, deduplicated, allowed to replace obsolete facts, and used to
   rebuild the index. Common credential formats and transient task state are excluded.
5. Writes are serialized. Extraction failures never fail the main conversation, and
   `session_shutdown` waits for queued maintenance.

## Storage layout

- In a git repo: `<gitRoot>/.pi/memory`
- Outside a repo: `~/.pi/agent/memory/<projectHash>`

```text
.pi/memory/
  MEMORY.md
  coding-style.md
  architecture.md
```

Each topic is Markdown with frontmatter:

```markdown
---
name: Coding style
description: Stable user preferences for code changes
type: user
---
- Prefer small, composable functions
```

Valid types are `user`, `feedback`, `project`, and `reference`.

## Recall and compaction

The first turn, and the first turn after `session_compact`, receives the full index and
maintenance instructions as a hidden custom message. Every turn may additionally receive
keyword-ranked topic bodies. Recall is deterministic and bounded by topic, byte, and
per-session limits; semantic/vector recall is not implemented.

## Commands

- `/memory list`
- `/memory show <name>`
- `/memory init` — optional idempotent repair/initialization command
- `/remember <text>` — explicit manual persistence and correction path

## Enable / disable

Enabled by default. Disable with `--no-memory` or `PI_MEMORY=0`.

## Design notes

The extension deliberately favors precision over recall: one-off requests, plans, current
progress, guesses, assistant-only claims, and secrets should not be persisted. Users can
inspect and edit the plain Markdown files at any time. Automatic extraction uses the active
conversation model only after the local signal gate matches, so most turns add no extra
model call.
