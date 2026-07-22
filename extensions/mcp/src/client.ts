// Minimal MCP client: orchestrates the initialize / tools/list / tools/call
// handshake over an injected Transport. All wire I/O lives behind Transport so
// this class is testable with a fake.

import type { McpContentItem, McpToolDef, Transport } from "./types.js";

const PROTOCOL_VERSION = "2025-06-18";

export interface CallToolResult {
  content: McpContentItem[];
  isError: boolean;
}

export class McpClient {
  private initialized = false;

  constructor(private readonly transport: Transport) {}

  /** Perform the initialize handshake and send the `initialized` notification. */
  async initialize(): Promise<unknown> {
    const result = await this.transport.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "pi-mcp", version: "0.1.0" },
      capabilities: {},
    });
    // Per spec the client acknowledges with a notification (best-effort).
    this.transport.notify?.("notifications/initialized", {});
    this.initialized = true;
    return result;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  /** List tools exposed by the server. */
  async listTools(): Promise<McpToolDef[]> {
    const result = (await this.transport.request("tools/list", {})) as {
      tools?: unknown;
    } | null;
    const tools = result?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.filter(
      (t): t is McpToolDef =>
        t !== null && typeof t === "object" && typeof (t as McpToolDef).name === "string",
    );
  }

  /** Invoke a tool, forwarding arguments; normalizes the content/isError shape. */
  async callTool(name: string, args: unknown): Promise<CallToolResult> {
    const result = (await this.transport.request("tools/call", {
      name,
      arguments: args ?? {},
    })) as { content?: unknown; isError?: unknown } | null;

    const content = Array.isArray(result?.content)
      ? (result?.content as McpContentItem[])
      : [];
    return { content, isError: result?.isError === true };
  }
}
