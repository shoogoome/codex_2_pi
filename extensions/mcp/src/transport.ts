// Thin runtime transports. StdioTransport spawns a long-lived child and speaks
// newline-delimited JSON-RPC over its stdio; HttpTransport POSTs JSON-RPC via
// the global fetch. The tricky framing lives in framing.ts (unit-tested); this
// file is intentionally thin and is not directly unit-tested (no real spawn /
// no real network in the suite).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { expandEnvRecord, expandEnvValue } from "./env.js";
import { buildJsonRpcRequest, classifyRpcMessage, createLineBuffer, encodeFrame, nextRequestId } from "./framing.js";
import type {
  JsonRpcResponse,
  McpHttpConfig,
  McpServerConfig,
  McpStdioConfig,
  Transport,
} from "./types.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

const REQUEST_TIMEOUT_MS = 30_000;

export class StdioTransport implements Transport {
  private child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number | string, Pending>();
  private readonly buffer = createLineBuffer();
  private closed = false;

  constructor(config: McpStdioConfig) {
    const expanded = expandEnvRecord(config.env);
    assertEnvAvailable(expanded.missing);
    this.child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...(expanded.values ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.onData(chunk));
    // Drain stderr so the pipe never blocks; not routed anywhere in the MVP.
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", () => {});
    this.child.on("error", (err) => this.failAll(err));
    this.child.on("exit", () => {
      if (!this.closed) this.failAll(new Error("MCP stdio server exited"));
    });
  }

  private onData(chunk: string): void {
    for (const msg of this.buffer.push(chunk)) {
      const c = classifyRpcMessage(msg);
      if (c.kind === "ignore") continue; // notification / non-object
      const p = this.pending.get(c.id);
      if (!p) continue;
      this.pending.delete(c.id);
      if (c.kind === "error") {
        p.reject(new Error(`${c.error.code}: ${c.error.message}`));
      } else {
        p.resolve(c.result);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("transport closed"));
    const id = nextRequestId();
    const frame = encodeFrame(buildJsonRpcRequest(id, method, params));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.child.stdin.write(frame);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    // Notifications carry no id.
    const frame = encodeFrame({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
    try {
      this.child.stdin.write(frame);
    } catch {
      // best-effort
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failAll(new Error("transport closed"));
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    try {
      this.child.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Escalate if the process ignores SIGTERM.
    const child = this.child;
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }, 2_000).unref?.();
  }
}

export class HttpTransport implements Transport {
  private readonly headers: Record<string, string>;
  private readonly url: string;

  constructor(private readonly config: McpHttpConfig) {
    const expandedUrl = expandEnvValue(config.url);
    const expandedHeaders = expandEnvRecord(config.headers);
    assertEnvAvailable([...new Set([...expandedUrl.missing, ...expandedHeaders.missing])]);
    this.url = expandedUrl.value;
    this.headers = expandedHeaders.values ?? {};
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const body = JSON.stringify(buildJsonRpcRequest(nextRequestId(), method, params));
    const res = await fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...this.headers,
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from MCP server`);
    }
    const text = await res.text();
    const parsed = parseHttpBody(text);
    const rpc = parsed as JsonRpcResponse;
    if (rpc?.error) {
      throw new Error(`${rpc.error.code}: ${rpc.error.message}`);
    }
    return rpc?.result;
  }

  notify(): void {
    // MVP: HTTP notifications are not delivered (no session channel). No-op.
  }

  close(): void {
    // Nothing to release for stateless POSTs.
  }
}

/**
 * Parse an HTTP MCP response body. Handles both a plain JSON body and a minimal
 * text/event-stream frame (take the first `data:` line's JSON).
 */
export function parseHttpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }
  // SSE-style: pull the first data: payload.
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (l.startsWith("data:")) {
      const payload = l.slice("data:".length).trim();
      if (payload.length > 0) return JSON.parse(payload);
    }
  }
  return JSON.parse(trimmed);
}

function assertEnvAvailable(missing: string[]): void {
  if (missing.length > 0) {
    throw new Error(`Missing environment variable(s): ${missing.join(", ")}`);
  }
}

function isStdio(config: McpServerConfig): config is McpStdioConfig {
  return typeof (config as McpStdioConfig).command === "string";
}

/** Factory: pick the transport implementation for a server config. */
export function createTransport(config: McpServerConfig): Transport {
  if (isStdio(config)) return new StdioTransport(config);
  return new HttpTransport(config as McpHttpConfig);
}
