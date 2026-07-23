// Pure builder: turn a server's tool list into registerTool payloads (minus the
// bound execute, which index.ts attaches with a live client). Keeps naming and
// schema-conversion decisions out of the I/O layer.

import type { TSchema } from "typebox";
import { mcpToolName, sanitizeMcpSegment } from "./naming.js";
import { jsonSchemaToTypeBox } from "./schema.js";
import type { McpToolDef } from "./types.js";

export interface ToolDefinitionSpec {
  /** Flat pi tool name: mcp__<server>__<tool>. */
  name: string;
  /** UI label: <server>:<tool>. */
  label: string;
  /** Description forwarded to the LLM (placeholder when the server omits one). */
  description: string;
  /** TypeBox parameter schema derived from the tool's inputSchema. */
  parameters: TSchema;
  /** Original MCP tool name (before flattening). */
  toolName: string;
}

export type ConvertFn = (schema: unknown) => TSchema;

/**
 * Build one spec per tool. `convert` defaults to jsonSchemaToTypeBox but is
 * injectable for testing. An empty tool list yields [].
 *
 * `server` is expected to already be a sanitized canonical id (see
 * `sanitizeServerName`). Each tool's name segment is sanitized here too as
 * defense in depth — remote tool names are usually already legal, but an
 * illegal char anywhere in the flat name still 400s the whole request. Only the
 * charset is normalized (`sanitizeMcpSegment`), so a tool name containing `__`
 * survives. The original (un-sanitized) tool name is kept in `toolName` because
 * that is what must be forwarded to the server on `tools/call`.
 */
export function buildToolDefinitions(
  server: string,
  tools: McpToolDef[],
  convert: ConvertFn = jsonSchemaToTypeBox,
): ToolDefinitionSpec[] {
  return tools.map((tool) => ({
    name: mcpToolName(server, sanitizeMcpSegment(tool.name)),
    label: `${server}:${tool.name}`,
    description:
      typeof tool.description === "string" && tool.description.trim().length > 0
        ? tool.description
        : `MCP tool ${tool.name} from server ${server}`,
    parameters: convert(tool.inputSchema),
    toolName: tool.name,
  }));
}
