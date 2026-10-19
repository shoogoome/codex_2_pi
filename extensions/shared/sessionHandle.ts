/**
 * Cross-extension session handles for Pi 0.84+.
 *
 * Each extension now receives its own `pi.events` facade (`{ emit, on }` only).
 * Writing extra properties on that object is invisible to other extensions.
 * The EventBus behind the facades is still shared inside one session, so we
 * publish the handle on a reserved query channel and also keep the direct
 * property for same-extension lookups and unit-test harnesses.
 */

export interface SessionHandleEvents {
  emit?(channel: string, data: unknown): void;
  on?(channel: string, handler: (data: unknown) => unknown): unknown;
}

export interface SessionHandleHost {
  events: Pick<SessionHandleEvents, "emit" | "on">;
}

function queryChannel(key: string): string {
  return `__pi_session_handle_query__:${key}`;
}

export function attachSessionHandle<T>(host: SessionHandleHost, key: string, handle: T): void {
  const events = host.events as SessionHandleEvents & Record<string, unknown>;
  events[key] = handle;
  if (typeof events.on !== "function") return;
  events.on(queryChannel(key), (reply) => {
    if (typeof reply === "function") (reply as (value: T) => void)(handle);
  });
}

export function getSessionHandle<T>(host: SessionHandleHost, key: string): T | undefined {
  const events = host.events as SessionHandleEvents & Record<string, unknown>;
  const direct = events[key];
  if (direct !== undefined) return direct as T;
  if (typeof events.emit !== "function") return undefined;
  let found: T | undefined;
  events.emit(queryChannel(key), (value: T) => {
    found = value;
  });
  return found;
}
