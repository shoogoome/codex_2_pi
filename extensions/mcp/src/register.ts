// Pure builder: turn a server's tool list into registerTool payloads (minus the
// bound execute, which index.ts attaches with a live client). Keeps naming and
// schema-conversion decisions out of the I/O layer.

import type { TSchema } from "typebox";
import { mcpToolName } from "./naming.js";
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
 */
export function buildToolDefinitions(
  server: string,
  tools: McpToolDef[],
  convert: ConvertFn = jsonSchemaToTypeBox,
): ToolDefinitionSpec[] {
  return tools.map((tool) => ({
    name: mcpToolName(server, tool.name),
    label: `${server}:${tool.name}`,
    description:
      typeof tool.description === "string" && tool.description.trim().length > 0
        ? tool.description
        : `MCP tool ${tool.name} from server ${server}`,
    parameters: convert(tool.inputSchema),
    toolName: tool.name,
  }));
}
