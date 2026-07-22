// Pure newline-delimited JSON-RPC framing used by the stdio transport. Kept
// side-effect free so the tricky partial-line buffering can be unit tested
// without spawning a process.

import type { JsonRpcRequest } from "./types.js";

let counter = 0;

/** Monotonic request id generator (module-local; stdio transport uses it). */
export function nextRequestId(): number {
  counter += 1;
  return counter;
}

/** Build a JSON-RPC 2.0 request frame. */
export function buildJsonRpcRequest(
  id: number | string,
  method: string,
  params?: unknown,
): JsonRpcRequest {
  const req: JsonRpcRequest = { jsonrpc: "2.0", id, method };
  if (params !== undefined) req.params = params;
  return req;
}

/** Serialize a JSON-RPC message and terminate it with a newline for stdio. */
export function encodeFrame(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Split a buffer into complete newline-delimited JSON messages plus the
 * trailing partial line. Empty lines are ignored; lines that fail to parse are
 * skipped (never throw).
 */
export function splitJsonRpcFrames(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  const parts = buffer.split("\n");
  // The last element is the (possibly empty) partial line that has no newline yet.
  const rest = parts.pop() ?? "";
  for (const line of parts) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      messages.push(JSON.parse(trimmed));
    } catch {
      // Skip malformed line — resilience over strictness for the MVP.
    }
  }
  return { messages, rest };
}

/**
 * Classify a parsed JSON-RPC message for response correlation. A frame with no
 * id (or a null id) is a server notification and is ignored; otherwise it is a
 * result or an error keyed by its request id. Pure — the stdio transport and
 * its tests share this so the correlation path is exercised identically.
 */
export type RpcClassification =
  | { kind: "result"; id: number | string; result: unknown }
  | { kind: "error"; id: number | string; error: { code: number; message: string; data?: unknown } }
  | { kind: "ignore" };

export function classifyRpcMessage(msg: unknown): RpcClassification {
  if (msg === null || typeof msg !== "object") return { kind: "ignore" };
  const m = msg as { id?: unknown; result?: unknown; error?: unknown };
  if (m.id === undefined || m.id === null) return { kind: "ignore" };
  const id = m.id as number | string;
  if (m.error !== null && typeof m.error === "object") {
    return { kind: "error", id, error: m.error as { code: number; message: string; data?: unknown } };
  }
  return { kind: "result", id, result: m.result };
}

/**
 * Stateful line buffer: feed raw stdout chunks, get back the complete parsed
 * messages, keeping any partial trailing line for the next chunk.
 */
export function createLineBuffer(): { push(chunk: string): unknown[] } {
  let pending = "";
  return {
    push(chunk: string): unknown[] {
      const { messages, rest } = splitJsonRpcFrames(pending + chunk);
      pending = rest;
      return messages;
    },
  };
}
