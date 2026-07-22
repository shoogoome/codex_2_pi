# pi-mcp-extension

A self-contained [Model Context Protocol](https://modelcontextprotocol.io) client for pi. It reads Claude-compatible `mcpServers` config, connects to each server over stdio or HTTP, and exposes every remote tool to the agent as a native pi tool named `mcp__<server>__<tool>`.

No external SDK is used — the JSON-RPC client, stdio framing, and HTTP transport are all implemented in-tree (`src/`).

## Configuration

Two files are read and merged, with **project overriding global** on name conflicts:

- Global: `~/.pi/agent/mcp.json`
- Project: `<cwd>/.pi/mcp.json`

Both use the Claude-style top-level `mcpServers` map. Each entry is either a stdio server or an HTTP/SSE server:

```jsonc
{
  "mcpServers": {
    // stdio: spawned as a long-lived child process
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "…" }
    },
    // http / sse: reached over the network via fetch
    "remote": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

An entry with a `command` is treated as stdio; an entry with a `url` (and optional `type: "http" | "sse"`) is treated as HTTP. Malformed JSON or unclassifiable entries degrade gracefully: the offending entry is skipped and a warning is shown; other servers and startup are unaffected.

## Tools

Each remote tool becomes a pi tool:

- Name: `mcp__<server>__<tool>` (e.g. `mcp__github__create_issue`)
- Parameters: the MCP `inputSchema` (JSON Schema) is converted to a TypeBox schema. Unsupported constructs (`oneOf`, `$ref`, …) relax to `Any`.
- Results: MCP `content` items map to pi tool-result content — `text` → text (byte-capped via `truncateHead` at `DEFAULT_MAX_BYTES`, with a `…[truncated N bytes]` note), `image` → image, and `resource`/other types are JSON-serialized into text.

## `/mcp` command

- `/mcp` or `/mcp list` / `/mcp status` — list configured servers with source, transport kind, connection state, and tool counts.
- `/mcp add` — interactively add a server (stdio or http/sse), write it to `.pi/mcp.json`, and connect.
- `/mcp remove` — remove a server from `.pi/mcp.json` and drop its connection. (Already-registered tools stay registered until the next restart, since pi has no tool-unregister API.)
- `/mcp reconnect` — tear down and re-establish all connections.

The footer shows `MCP: N server(s)` for the number of connected servers.

## Approvals

This extension does **not** implement its own approval gate. The `approvals` extension already intercepts any tool whose name starts with `mcp__` (server-level matcher `mcp__<server>` matches all of that server's tools), so MCP tool calls flow through the standard allow/ask/deny gate automatically.

## Runtime injection (plugin-loader)

Other extensions (e.g. a Claude-plugin loader) can inject servers at runtime by emitting on the pi event bus:

```ts
pi.events.emit("mcp:register-server", {
  name: "my-server",
  config: { command: "my-mcp-binary", args: ["--stdio"] },
});
```

The payload is validated (`{ name, config }`), normalized through the same stdio/http classifier, connected, and its tools registered — all without a restart.

## Robustness / limits

- Per-server connect failures never throw or block startup; they surface as a notification and an `error` status in `/mcp list`.
- `session_shutdown` closes every transport (stdio children receive `SIGTERM`, then `SIGKILL` if they linger).
- SSE is handled in the MVP as a single POST whose response may be a JSON body or the first `data:` frame; true streaming SSE sessions (`Mcp-Session-Id`, long-lived GET) are not implemented.

## Layout

- `index.ts` — the only place that touches the pi API, the filesystem, processes, or the network.
- `src/config.ts` — parse/merge/mutate config (pure).
- `src/schema.ts` — JSON Schema → TypeBox (pure).
- `src/naming.ts` — `mcp__server__tool` mapping (pure).
- `src/framing.ts` — newline-delimited JSON-RPC framing (pure).
- `src/result.ts` — MCP content → pi tool result (pure, injected `truncateHead`).
- `src/client.ts` — minimal MCP client over an injected `Transport`.
- `src/register.ts` — build `registerTool` payloads (pure).
- `src/transport.ts` — thin stdio (`spawn`) and HTTP (`fetch`) transports.
