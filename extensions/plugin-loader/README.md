# plugin-loader

Claude Code 风格插件管理与加载扩展。详细中文文档见 [`../../docs/extensions/plugin-loader.md`](../../docs/extensions/plugin-loader.md)。

## Commands

```text
/plugin
/plugin list [--available] [--json]
/plugin marketplace add|list|remove|update ...
/plugin install|i <plugin@marketplace> [--scope user|project|local]
/plugin uninstall|remove <plugin> [--scope ...] [--keep-data] [--prune]
/plugin enable|disable <plugin> [--scope ...]
/plugin update <plugin> [--scope ...]
/plugin details <plugin>
/plugin configure <plugin> key=value ...
/plugin validate <path>
/plugin init|new <name> [parent]
/plugin prune|autoremove [--scope ...]
```

Bare `/plugin` opens a small interactive menu. Marketplaces may be local directories, GitHub `owner/repo` shorthands, or git URLs.

## Components

- skills and manifest skill paths
- commands converted to `/<plugin>_<command>` Pi prompts; each command body is wrapped in pi's `<skill name="..." location="...">` block format so invoking it collapses to a one-line `[skill] <plugin>_<command>` row in the TUI (with any trailing args shown as a separate user message) instead of dumping the prompt text
- themes and output styles
- agents bridged to the agents extension
- hooks bridged to hooks-runner, with plugin root/data/user-config variables
- MCP servers registered and reconciled through Pi 1.0's native `registerMcpServer` API (default `codemode`, discover tools with `searchTools()`)
- LSP is detected but deferred because Pi has no dynamic LSP API

Installed state and caches are scope-aware (`user`, `project`, `local`). Manually discovered plugins under `~/.pi/agent/plugins/`, `.pi/plugins/`, and `--plugin-dir` remain supported.

After changing plugin state, run `/reload`; a restart may still be necessary where the Pi host cannot unregister already-created tools or subprocess-backed resources.
