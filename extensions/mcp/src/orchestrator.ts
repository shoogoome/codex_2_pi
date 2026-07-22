// Pure connect orchestration over an injected Transport: run the MCP handshake
// (initialize → tools/list), turn each tool into a registerTool spec, and hand
// every spec to the caller's `register` sink. No pi API and no I/O beyond the
// transport, so a fake transport fully exercises the flow
// connect→initialize→tools/list→per-tool register (+ tools/call forwarding via
// the returned client) without spawning a process or hitting the network.

import { McpClient } from "./client.js";
import { buildToolDefinitions } from "./register.js";
import type { ToolDefinitionSpec } from "./register.js";
import type { McpToolDef, Transport } from "./types.js";

export interface ConnectServerResult {
  client: McpClient;
  tools: McpToolDef[];
  specs: ToolDefinitionSpec[];
}

/**
 * Drive the full connect handshake and register each discovered tool.
 *
 * The caller supplies `register` (typically pi.registerTool bound with a live
 * execute) and receives the connected client back so it can forward tools/call
 * at invocation time. index.ts intentionally resolves the client from its
 * registry at call time (to survive reconnects) rather than closing over the
 * one returned here.
 */
export async function connectServer(
  server: string,
  transport: Transport,
  register: (spec: ToolDefinitionSpec) => void,
): Promise<ConnectServerResult> {
  const client = new McpClient(transport);
  await client.initialize();
  const tools = await client.listTools();
  const specs = buildToolDefinitions(server, tools);
  for (const spec of specs) register(spec);
  return { client, tools, specs };
}
