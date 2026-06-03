// Deprecated thin re-export — kept for compatibility. New code should
// import directly from "./protocol.js". Will be removed in a future task
// once all internal call sites migrate.
//
// detectShutdownProtocol returns "request" | "response" (legacy two-value
// API). The new detectProtocol in protocol.ts returns the full kind
// string ("shutdown_request" / "shutdown_response" / future).

export {
  type ShutdownRequest,
  type ShutdownResponse,
  buildShutdownRequest,
  buildShutdownResponse,
  parseShutdownRequest,
  parseShutdownResponse,
} from "./protocol.js";

import { detectProtocol } from "./protocol.js";

/**
 * Legacy API: returns "request" | "response" | undefined.
 * Prefer detectProtocol() from "./protocol.js" which returns the specific
 * kind string.
 */
export function detectShutdownProtocol(body: string): "request" | "response" | undefined {
  const kind = detectProtocol(body);
  if (kind === "shutdown_request") return "request";
  if (kind === "shutdown_response") return "response";
  return undefined;
}
