# agents-context

Supplemental project-context loading for Pi. This extension only does what Pi's
native context loader does **not** — it never re-injects a file Pi already fed
into the system prompt.

## What Pi already does (not this extension)

`loadProjectContextFiles({ cwd, agentDir })` already:

- loads one global context file from the agent dir (`~/.pi`), and
- walks `cwd` → `/`, taking the **first** of
  `AGENTS.md` / `AGENTS.MD` / `CLAUDE.md` / `CLAUDE.MD` per directory.

So multi-level `AGENTS.md`/`CLAUDE.md` discovery and the `~/.pi` global file are
already covered natively. This extension does **not** duplicate them.

## Net-new capabilities

1. **Same-directory second file** — Pi takes only one file per directory; if a
   directory has both `AGENTS.md` and `CLAUDE.md`, the one Pi skipped is added.
2. **`.claude/rules/**/*.md`** at every level (project) plus `~/.claude/rules/`
   and `~/.pi/rules/` (user) — Pi never loads these.
3. **`@path` includes** — recursive, relative / `~/` / absolute, cycle-guarded,
   max depth 5, skipping references inside fenced and inline code, `#fragment`
   stripped, non-text extensions and missing files ignored.
4. **Conditional `paths:` frontmatter rules** — a rule with a `paths:` glob (a
   comma-separated string, an inline `[a, b]` list, or a YAML block list) is only
   injected once the model reads/edits/writes a file matching one of its globs.
   A catch-all `**` is treated as unconditional. This keeps rarely-relevant
   guidance out of the context until it matters.
5. **User global layer (net-new)** — `~/.claude/CLAUDE.md`, `~/.claude/rules/`,
   `~/.pi/rules/`.
6. **Local layer** — `CLAUDE.local.md` and `AGENTS.override.md` at every level.

## Merge, dedup, budget

- Discovered files are merged in `user` → `project` → `local` order.
- Every file carries a provenance header comment
  (`<!-- from <path>, layer: <layer>[, matched: <rel>][, truncated] -->`).
- Each file is capped at a byte budget (default 32 KB, codex parity). Over-budget
  files are cut at a line boundary and marked `truncated`.
- Before injecting, the set of paths Pi already loaded (from
  `before_agent_start`'s `systemPromptOptions.contextFiles`) is removed, so a
  file Pi already fed in is never injected twice.

## Injection lifecycle

- **`session_start`**: anchor the project root (`.git`/`.hg`/`.svn`/`package.json`
  marker, else cwd), discover + cache all supplemental files (read, expand
  `@includes`, parse frontmatter), and reset the injection latch. Nothing is
  injected yet — dedup needs the Pi-loaded set, only known later.
- **`tool_call`**: record `read`/`edit`/`write` target paths to drive conditional
  rules.
- **`before_agent_start`**: dedup against Pi-loaded files, then inject a single
  `display: false` message containing the unconditional block (once) plus any
  conditional rules whose globs match a touched path. The message persists on the
  branch, so it is not re-sent every turn.
- **`session_compact`**: compaction drops the injected message, so the latch is
  reset and the block is re-injected on the next turn.

## Enable / disable

Enabled by default. Disable with the CLI flag `--no-agents-context` (or set the
flag to `false`), or set the env var `PI_AGENTS_CONTEXT=0`.

## Known limitations

- Conditional rules only see `read`/`edit`/`write` tool targets. Files touched
  only via `bash` are not detected (heuristic limit).
- The glob matcher supports a subset of glob syntax (`**`, `*`, `?`, literals)
  rather than full `.gitignore`/picomatch semantics, to avoid adding a new
  dependency.
- Cached file contents are not refreshed if a context file is edited mid-session
  (v1 behavior).
