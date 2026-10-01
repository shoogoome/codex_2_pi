import { assertSafeCursorBaseUrl } from "../utils/security.js";
import { cursorRequestBaseUrl, cursorRequestEnv } from "../client/request-context.js";

export const DEFAULT_CURSOR_AGENT_URL = "https://agentn.us.api5.cursor.sh";
export const DEFAULT_CURSOR_CLIENT_VERSION = "cli-2026.07.23-e383d2b";

export function getCursorClientVersion(): string {
  return cursorRequestEnv("PI_CURSOR_CLIENT_VERSION")?.trim() || DEFAULT_CURSOR_CLIENT_VERSION;
}

/** Explicit configuration only: never inspect Cursor CLI/IDE configuration or credentials. */
export function getCursorAgentUrl(): string {
  const raw = cursorRequestEnv("PI_CURSOR_AGENT_URL")?.trim()
    || cursorRequestEnv("CURSOR_AGENT_URL")?.trim()
    || cursorRequestBaseUrl()
    || DEFAULT_CURSOR_AGENT_URL;
  return assertSafeCursorBaseUrl(raw);
}
