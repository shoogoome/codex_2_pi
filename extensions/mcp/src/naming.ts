// Pure tool-name mapping between an MCP (server, tool) pair and the flat
// `mcp__<server>__<tool>` name space that pi and the approvals gate expect.

const PREFIX = "mcp__";

/** Build the flat tool name for a server/tool pair. */
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
