// Shared type-only definitions for the MCP extension. No runtime values here.

/** A stdio-launched MCP server: spawned as a long-lived child process. */
export interface McpStdioConfig {
  /** Executable to spawn. Presence of `command` marks a stdio server. */
  command: string;
  /** Command-line arguments. */
  args?: string[];
  /** Extra environment variables merged onto the current process env. */
  env?: Record<string, string>;
}

/** An HTTP/SSE MCP server reached over the network. */
export interface McpHttpConfig {
  /** Transport kind. "sse" is treated as a single-shot POST in the MVP. */
  type: "http" | "sse";
  /** Endpoint URL. */
  url: string;
  /** Extra request headers. */
  headers?: Record<string, string>;
}

/** A single server entry from an `mcpServers` map. */
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

/** The on-disk config file shape (Claude-compatible `mcpServers`). */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

/** Where a merged server entry came from. */
export type ServerSource = "project" | "global" | "runtime";

/** A merged server entry with its provenance. */
export interface MergedServer {
  name: string;
  config: McpServerConfig;
  source: ServerSource;
}

/** JSON-RPC 2.0 request frame. */
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 notification frame (no id). */
export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

/** JSON-RPC 2.0 response frame. */
export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** A tool definition as returned by an MCP server's tools/list. */
export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** A content item returned by tools/call. */
export interface McpContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  /** resource / other payloads land here. */
  [key: string]: unknown;
}

/** Minimal transport contract shared by stdio and http implementations. */
export interface Transport {
  /** Send a JSON-RPC request and resolve with its `result`. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Fire-and-forget notification (optional). */
  notify?(method: string, params?: unknown): void;
  /** Tear down the transport (kill child process / release resources). */
  close(): void;
}

/** Payload accepted on the `mcp:register-server` event bus channel. */
export interface McpRegistration {
  name: string;
  config: unknown;
}
