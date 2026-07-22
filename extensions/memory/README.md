# pi-memory-extension

Claude-style long-term memory for Pi. Gives the agent a persistent, git-root-scoped
memory directory whose index and recalled topics are injected into context each turn,
and re-injected after compaction. The **model** maintains the memory files with ordinary
`write`/`edit`; the harness only locates/scaffolds the directory, injects, and exposes
two commands.

## What the harness does (and does not) do

The harness does three things only:

1. **Locate/create** a git-root-scoped memory directory.
2. **Inject** the `MEMORY.md` index + query-time recalled topic bodies + a rules block via
   `before_agent_start`, re-injecting the index after each compaction.
3. **Expose** `/memory` and `/remember` commands.

It does **not** own a bespoke storage tool. The model reads and edits the memory files
itself. Automatic extraction (background sub-agent distillation) and semantic recall are
explicitly **phase-2** and out of MVP scope — the `turn_end` / `session_shutdown` hooks are
wired as documented no-ops and never fork sub-agents.

## Storage layout

- **In a git repo:** `<gitRoot>/.pi/memory`
- **Off-repo fallback:** `~/.pi/agent/memory/<projectHash>` (hash derived from cwd, matching
  the `~/.pi/agent/*` convention used by the mcp / plugin-loader extensions)

Inside that directory:

```
.pi/memory/
  MEMORY.md        # index: one line per topic
  coding-style.md  # a topic file
  architecture.md  # a topic file
  ...
```

### Topic frontmatter

Each topic `.md` file begins with frontmatter:

```markdown
---
name: Coding style
description: How the user likes code written (one line, used for recall)
type: user
---
- Prefers tabs over spaces
- Wants small, composable functions
```

`type` is one of:

| type        | meaning                                            |
|-------------|----------------------------------------------------|
| `user`      | the user's stable preferences / identity           |
| `feedback`  | corrections the user gave you                       |
| `project`   | durable facts about this codebase                   |
| `reference` | external knowledge worth keeping                    |

### MEMORY.md index format

One round-trippable line per topic:

```markdown
- `coding-style.md` — **Coding style** (user): How the user likes code written
```

The parser tolerates hand-edits: any line matching that shape is read, everything else is
ignored, so the model can add prose around the list freely.

## Injection

On the first turn of a session (and the first turn after each compaction), the injected
`display:false` message carries:

- a **rules block** teaching the model where the memory dir is and how to maintain it,
- the **full `MEMORY.md` index**.

On every turn it may additionally carry **recalled topic bodies** relevant to the current
prompt. Recall (MVP) is deterministic keyword scoring over topic name/description/body,
bounded by:

- at most `5` topics per turn,
- a per-topic byte budget (line-boundary truncation),
- a per-session cumulative cap on distinct topics recalled.

Semantic recall is deferred to phase 2.

## Commands

- `/remember <text>` — append a timestamped bullet to a target topic (default *General
  notes*), creating it if needed, and keep `MEMORY.md` in sync. Guarded on idle so it never
  races the agent's own writes.
- `/memory list` — list topics grouped by type.
- `/memory show <name>` — print a topic's body.
- `/memory init` — scaffold the memory directory + a blank `MEMORY.md`.

Without a UI, commands degrade to one-line notifications.

## Enable / disable

Enabled by default. Disable with the `--no-memory` flag or `PI_MEMORY=0`.

## Architecture

`index.ts` is the only file that touches the pi `ExtensionAPI` and `node:fs`. All logic —
git-root location, frontmatter parsing, `MEMORY.md` parse/build, keyword recall + budget
truncation, the per-session injection state machine, and command planning — lives in `src/`
as pure functions over an injected `FsLike`, each with a Vitest file driven by an in-memory
fake filesystem (no real shell / network / spawn).
