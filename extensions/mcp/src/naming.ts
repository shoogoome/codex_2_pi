// Pure tool-name mapping between an MCP (server, tool) pair and the flat
// `mcp__<server>__<tool>` name space that pi and the approvals gate expect.
//
// OpenAI-family models reject any function whose name is not `^[a-zA-Z0-9_-]+$`
// (and must start with a letter). Server names injected by plugin-loader look
// like `${plugin}:${server}` (e.g. `zhiyan:zhiyan-log`) — the colon is illegal
// and makes the ENTIRE Chat Completions request 400, not just that one tool.
// So every segment is sanitized to that charset before it becomes a tool name.
// `sanitizeMcpName` mirrors Claude Code's `normalizeNameForMCP`.

const PREFIX = "mcp__";

/**
 * Charset-only sanitization: replace every char outside [A-Za-z0-9_-] with "_".
 * This is the minimum needed for OpenAI legality and deliberately does NOT
 * collapse or strip underscores, so a tool name that legitimately contains
 * `__` (pi splits a flat name on the first two `__`, so the tool segment may
 * hold more) survives unchanged. Use this for the TOOL segment.
 */
export function sanitizeMcpSegment(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * Full server-name sanitization to OpenAI's function-name charset:
 *   - any char outside [A-Za-z0-9_-] → "_"
 *   - collapse runs of "_" into one
 *   - strip leading/trailing "_"
 * The collapse is essential for the SERVER segment: the flat name is parsed by
 * splitting on the first `__`, so a server id must never itself contain `__`
 * (e.g. `a::b` → without collapse `a__b`, which would mis-parse). Idempotent on
 * already-legal names. May return "" for entirely-illegal input; callers that
 * need a non-empty id use `sanitizeServerName`.
 */
export function sanitizeMcpName(name: string): string {
  return sanitizeMcpSegment(name)
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Sanitize a server name into a canonical id and resolve collisions against
 * `taken` (already-allocated canonical ids) by appending `_2`, `_3`, … Empty
 * sanitization results fall back to "server" so the flat name can never
 * collapse into an unparseable `mcp____<tool>` form. The full tool name is
 * always `mcp__`-prefixed, so it is guaranteed to start with a letter
 * regardless of what the server segment sanitizes to.
 */
export function sanitizeServerName(name: string, taken: ReadonlySet<string> = new Set()): string {
  const base = sanitizeMcpName(name) || "server";
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i += 1;
  return `${base}_${i}`;
}

/**
 * Build the flat tool name for a server/tool pair. Both segments are expected to
 * already be sanitized (server via `sanitizeServerName` at the registration
 * boundary, tool via `sanitizeMcpName` in `buildToolDefinitions`); this is a
 * pure joiner and does not re-sanitize.
 */
export function mcpToolName(server: string, tool: string): string {
  return `${PREFIX}${server}__${tool}`;
}

/**
 * Parse a flat name back into its server/tool parts. Splits on the FIRST two
 * `__` boundaries so a tool name may itself contain `__`. Returns undefined for
 * names that are not `mcp__`-prefixed or lack a server/tool segment.
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(PREFIX)) return undefined;
  const rest = name.slice(PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return undefined;
  const server = rest.slice(0, sep);
  const tool = rest.slice(sep + 2);
  if (server.length === 0 || tool.length === 0) return undefined;
  return { server, tool };
}
