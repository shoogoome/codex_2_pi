# plugin-loader

Discovers **Claude-style plugins** on disk and wires their components into pi.
A plugin is a directory containing a manifest and, by convention, resource
subdirectories (`commands/`, `skills/`, `themes/`, `output-styles/`, …).

## Where plugins are found

Discovered one level under each of these roots (higher precedence first; on a
name collision the first-seen plugin wins):

1. `--plugin-dir <dir1,dir2,…>` (comma-separated, relative paths resolved against cwd)
2. `~/.pi/agent/plugins/*`
3. `<cwd>/.pi/plugins/*`

## Manifest precedence

For each plugin directory the loader probes, in order:

1. `.pi-plugin/plugin.json` (pi-native)
2. `.claude-plugin/plugin.json` (Claude)
3. `.cursor-plugin/plugin.json` (Cursor)

The first that exists is parsed. A plugin **without** any manifest still loads as
a minimal plugin named after its directory, with resources detected by convention.

The parsed manifest subset: `name`, `version`, `description`, `commands`,
`agents`, `skills`, `outputStyles`, `mcpServers`, `hooks`. Missing/malformed
fields degrade gracefully (never throws).

## What it loads

| Component | Source | How it is wired |
|-----------|--------|-----------------|
| Skills | `skills/` dir | Returned as `skillPaths` from `resources_discover`; pi reads foreign skill dirs natively (zero translation). |
| Commands | `commands/*.md` + manifest `commands` | Transformed to pi prompt templates, written to `~/.pi/agent/plugin-loader/<plugin>/prompts/`, returned via `promptPaths`. Invoked as `/<plugin>_<command>`. |
| Themes | `themes/` dir | Returned as `themePaths`. |
| Output styles | `output-styles/*.md` | Collected at load; applied on `before_agent_start` when one is selected. |
| MCP servers | manifest `mcpServers` (inline / paths) + root `.mcp.json` | Each server emitted on the `mcp:register-server` bus as `${plugin}:${server}` for the **mcp extension** to register. |

### Command transform

- `description` and `argument-hint` frontmatter are kept; Claude-only
  `allowed-tools` / `model` are dropped (pi prompt templates have no equivalent).
- `$ARGUMENTS` is normalized to `$@`; positional `$1`, `$2`, … and `$@` are preserved.
- `${CLAUDE_PLUGIN_ROOT}` / `$CLAUDE_PLUGIN_ROOT` in the body are substituted with
  the plugin's real absolute root.
- Namespacing is by filename prefix (`<plugin>_<command>.md`). pi has no true
  command namespace, so cross-plugin collisions are only mitigated, not prevented.

### Output styles

Select one with `--plugin-output-style <name-or-id>` (matched by frontmatter
`name` first, then file stem). `--plugin-output-style-mode` chooses `append`
(default — style appended to the assembled system prompt) or `replace`.

### MCP servers

Server configs are var-substituted (`CLAUDE_PLUGIN_ROOT` only, this phase) and
handed to the **mcp extension** via `pi.events.emit("mcp:register-server", …)`.
Because the event bus has no acknowledgement, the loader detects the mcp
extension best-effort by looking for an `mcp` slash command; if absent while
plugins declare servers, it warns once that the mcp extension is needed.

## `/plugin` command

- `/plugin list` (or bare `/plugin`) — every discovered plugin, its enabled
  state, what it contributes, and any deferred features.
- `/plugin enable <name>` / `/plugin disable <name>` — persisted via a session
  custom entry (replayed on the next session start). A disabled plugin
  contributes nothing. Run `/reload` to apply resource changes.

## Deferred this phase

- **hooks** (`hooks/hooks.json`) — needs a hooks-runner extension.
- **agents** (`agents/*.md`) — needs a subagent extension.

Both are surfaced in `/plugin list` as `deferred: …` so partially-loaded plugins
are obvious. `resources_discover` cannot inject new extensions at runtime, so
these cannot be hot-loaded here.

Also not yet substituted: `CLAUDE_PLUGIN_DATA`, `${user_config.X}`, and secret
variables — only `CLAUDE_PLUGIN_ROOT` is resolved this phase.
