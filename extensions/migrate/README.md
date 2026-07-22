# migrate

One-shot importer of **Claude Code** / **Cursor** configuration into pi's own
config surface under `<cwd>/.pi/`. Exposed as the `/migrate` command.

`/migrate` detects the config that Claude Code and Cursor already keep on your
machine and in the project, maps it into the formats pi's own extensions
consume, and writes only the entries pi is still missing. It never overwrites
existing pi config — unrelated keys and entries are preserved.

## Usage

```
/migrate            # detect, preview, then per-category confirm + final apply
/migrate --dry-run  # preview only; writes nothing
/migrate mcp        # migrate a single category (mcp|agents|commands|hooks|memory)
```

- **Interactive (has UI):** shows the plan, asks per category whether to
  include it, then asks for one final confirmation before writing.
- **`--dry-run`:** always short-circuits after the preview — nothing is written.
- **Non-interactive (no UI) with no category argument:** stays preview-only for
  safety. Pass an explicit category (e.g. `/migrate mcp`) to apply
  non-interactively.

## Sources → targets

| Source | Files read | pi target | Notes |
|---|---|---|---|
| MCP | `.claude/settings.json`, `.claude/settings.local.json`, `.claude/.mcp.json`, `.cursor/mcp.json` (user + project) | `<cwd>/.pi/mcp.json` (`mcpServers` map) | Normalized to pi's stdio `{command,args,env}` / http-sse `{type,url,headers}` shape. |
| Subagents | `.claude/agents/*.md` | `<cwd>/.pi/agents/<name>.md` | Frontmatter `name→agentType`, `description→whenToUse`+`description`, `tools` comma-split, `model` mapped to `sonnet\|opus\|haiku\|inherit` (unknown dropped); body kept as system prompt. |
| Commands | `.claude/commands/**/*.md` | `<cwd>/.pi/prompts/<name>.md` | Keeps `description`/`argument-hint`, drops `allowed-tools`/`model`, rewrites `$ARGUMENTS`→`$@` (preserves `$1`/`$2`/`$@`). Nested dirs are namespaced (`dir:sub_name`). |
| Hooks | `.claude/settings*.json` `hooks` map (honors `disableAllHooks`) | `<cwd>/.pi/hooks.json` | Merged per event group, deduped by `(event, matcher, command)` triple. |
| Memory | `CLAUDE.md`, `.cursor/rules/*` | — (no copy) | Informational only: `agents-context` loads `CLAUDE.md`/`AGENTS.md` natively, so the plan lists it as "already loaded, no action". |

Cursor exposes only MCP (`mcp.json`) and rules; it has no subagents, commands,
or hooks equivalents, so those categories are Claude-only.

## Only-missing semantics (dedup)

Re-running `/migrate` is safe. Items already present on the pi side are marked
`skip`, never re-imported. Identity is compared per category:

- **MCP** — by server name (existing project `.pi/mcp.json` wins).
- **Agents** — by target filename `<name>.md`.
- **Commands** — by target prompt-template name.
- **Hooks** — by the `(event, matcher, command)` triple.

If sources exist but pi already has everything importable, the command reports
"nothing new to migrate" after showing the preview.

## Warnings

Servers imported from `~/.claude` may carry secrets in their `env`/`headers`.
Any such server is flagged in the preview so you can review before confirming,
since migration copies the values verbatim into the project's `.pi/mcp.json`.

Malformed source files degrade gracefully: the bad file is skipped, a warning is
collected into the plan, and the rest of the migration proceeds.

## Layout

- `index.ts` — the only file touching the pi API and the real filesystem:
  registers `/migrate` + the `--dry-run` flag, builds a `node:fs` `FsFacade`,
  drives the UI, and applies the plan (atomic `mkdirSync` recursive +
  `writeFileSync`, JSON merge). Every write is guarded so one failure never
  aborts the run.
- `src/` — pure, injected-`FsFacade` functions (no I/O), unit-tested:
  - `sources.ts` — detect candidate Claude/Cursor roots and present files.
  - `parseClaude.ts` / `parseCursor.ts` — parse each source into a `ParsedConfig`.
  - `mapMcp.ts` / `mapAgents.ts` / `mapCommands.ts` / `mapHooks.ts` — map to pi
    target formats + text merge helpers.
  - `plan.ts` — combine parsed sources with existing pi state into a
    `MigrationPlan` (create-vs-skip dedup) and render the preview.
  - `types.ts` — shared type-only definitions.
