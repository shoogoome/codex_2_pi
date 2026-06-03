// Shutdown handshake protocol.
//
// The leader initiates a graceful kill by sending a MailboxMessage whose body
// is `{"type":"shutdown_request","request_id":"<uniq>"}`. The teammate's loop
// parses the body, decides approve / reject, and sends back
// `{"type":"shutdown_response","request_id":"<same>","approve":<bool>,
//  "feedback?":"<reason>"}`. The leader (or team_delete) waits for the response
// (or times out and force-kills).
//
// This module is pure: encode + decode + structural validation. No I/O.

export interface ShutdownRequest {
  type: "shutdown_request";
  request_id: string;
}

export interface ShutdownResponse {
  type: "shutdown_response";
  request_id: string;
  approve: boolean;
  feedback?: string;
}

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

function tryParse(body: string): unknown | undefined {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

export function parseShutdownRequest(body: string): ShutdownRequest | undefined {
  const v = tryParse(body);
  if (typeof v !== "object" || v === null) return undefined;
  const obj = v as Record<string, unknown>;
  if (obj.type !== "shutdown_request") return undefined;
  if (typeof obj.request_id !== "string" || obj.request_id.length === 0) return undefined;
  return { type: "shutdown_request", request_id: obj.request_id };
}

export function parseShutdownResponse(body: string): ShutdownResponse | undefined {
  const v = tryParse(body);
  if (typeof v !== "object" || v === null) return undefined;
  const obj = v as Record<string, unknown>;
  if (obj.type !== "shutdown_response") return undefined;
  if (typeof obj.request_id !== "string" || obj.request_id.length === 0) return undefined;
  if (typeof obj.approve !== "boolean") return undefined;
  if (obj.feedback !== undefined && typeof obj.feedback !== "string") return undefined;
  const resp: ShutdownResponse = {
    type: "shutdown_response",
    request_id: obj.request_id,
    approve: obj.approve,
  };
  if (typeof obj.feedback === "string") resp.feedback = obj.feedback;
  return resp;
}

export function detectShutdownProtocol(body: string): "request" | "response" | undefined {
  if (parseShutdownRequest(body)) return "request";
  if (parseShutdownResponse(body)) return "response";
  return undefined;
}
