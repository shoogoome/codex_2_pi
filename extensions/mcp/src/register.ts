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
  /**
   * One-line entry for the system prompt's `Available tools` section.
   *
   * Pi only lists a custom tool there when `promptSnippet` is set — omit it and
   * the tool is callable but invisible, so the model has no way to know the
   * tool exists short of guessing a name. Real failure observed: an agent probed
   * three read-only MCP tools, concluded "the image-generation tools are not in
   * my tool list", and reported the environment as broken — every tool was in
   * fact registered.
   */
  promptSnippet: string;
};

export type ConvertFn = (schema: unknown) => TSchema;

/** Cap on a snippet so one verbose server cannot bloat the system prompt. */
const SNIPPET_MAX = 100;

/**
 * Build the `Available tools` line for one tool: `<server>: <tool> — <hint>`.
 *
 * The snippet deliberately leads with the callable name shape (`mcp__srv__tool`)
 * because that is what the model must emit, and appends the server's own
 * description as the hint. Without the hint the model can read the name but
 * still not know what the tool does.
 */
function buildPromptSnippet(server: string, toolName: string, description: string): string {
  const flat = mcpToolName(server, sanitizeMcpSegment(toolName));
  const hint = description.replace(/\s+/g, " ").trim();
  if (hint.length === 0) return flat;
  const clipped = hint.length > SNIPPET_MAX ? `${hint.slice(0, SNIPPET_MAX - 1)}…` : hint;
  return `${flat} — ${clipped}`;
}

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
    promptSnippet: buildPromptSnippet(
      server,
      tool.name,
      typeof tool.description === "string" ? tool.description : "",
    ),
  }));
}
