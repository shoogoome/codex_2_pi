// Mailbox message protocol bodies. Each protocol is a discriminated union
// member keyed by `type`. Build functions return stringified JSON to put
// in MailboxMessage.body; parse functions defensively parse + validate
// arbitrary strings.
//
// Adding a new protocol:
//   1. Add an interface extending ProtocolBase
//   2. Add it to the ProtocolBody union
//   3. Add buildXxx / parseXxx helpers
//   4. Wire into detectProtocol's discriminator switch
//
// All protocols travel via send_message — JSON bodies are detected
// automatically and marked isProtocol:true on the MailboxMessage.

interface ProtocolBase {
  type: string;
}

export interface ShutdownRequest extends ProtocolBase {
  type: "shutdown_request";
  request_id: string;
}

export interface ShutdownResponse extends ProtocolBase {
  type: "shutdown_response";
  request_id: string;
  approve: boolean;
  feedback?: string;
}

export type ProtocolBody = ShutdownRequest | ShutdownResponse;

export type ProtocolKind = ProtocolBody["type"];

// === Build helpers ===

export function buildShutdownRequest(requestId: string): string {
  const req: ShutdownRequest = { type: "shutdown_request", request_id: requestId };
  return JSON.stringify(req);
}

export function buildShutdownResponse(
  requestId: string,
  approve: boolean,
  feedback?: string,
): string {
  const resp: ShutdownResponse = {
    type: "shutdown_response",
    request_id: requestId,
    approve,
  };
  if (feedback !== undefined) resp.feedback = feedback;
  return JSON.stringify(resp);
}

// === Parse helpers ===

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export function parseShutdownRequest(body: string): ShutdownRequest | undefined {
  const v = tryParseJson(body);
  if (!isObject(v)) return undefined;
  if (v.type !== "shutdown_request") return undefined;
  if (typeof v.request_id !== "string" || v.request_id.length === 0) return undefined;
  return { type: "shutdown_request", request_id: v.request_id };
}

export function parseShutdownResponse(body: string): ShutdownResponse | undefined {
  const v = tryParseJson(body);
  if (!isObject(v)) return undefined;
  if (v.type !== "shutdown_response") return undefined;
  if (typeof v.request_id !== "string" || v.request_id.length === 0) return undefined;
  if (typeof v.approve !== "boolean") return undefined;
  if (v.feedback !== undefined && typeof v.feedback !== "string") return undefined;
  const resp: ShutdownResponse = {
    type: "shutdown_response",
    request_id: v.request_id,
    approve: v.approve,
  };
  if (typeof v.feedback === "string") resp.feedback = v.feedback;
  return resp;
}

// === Generic detector ===

/**
 * Detect any known protocol kind from a raw mailbox body. Returns the
 * specific kind ("shutdown_request" / "shutdown_response" / future…) or
 * undefined for plain-text / unknown JSON.
 */
export function detectProtocol(body: string): ProtocolKind | undefined {
  if (parseShutdownRequest(body)) return "shutdown_request";
  if (parseShutdownResponse(body)) return "shutdown_response";
  return undefined;
}

/**
 * Parse a raw body to a fully-typed ProtocolBody, or undefined if not a
 * known protocol. Convenience wrapper for callers that need the parsed
 * obj plus the kind in one step.
 */
export function parseProtocol(body: string): ProtocolBody | undefined {
  const req = parseShutdownRequest(body);
  if (req) return req;
  const resp = parseShutdownResponse(body);
  if (resp) return resp;
  return undefined;
}
