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
  [key: string]: unknown;
}

export interface SessionHandleHost {
  events: SessionHandleEvents;
}

function queryChannel(key: string): string {
  return `__pi_session_handle_query__:${key}`;
}

export function attachSessionHandle<T>(host: SessionHandleHost, key: string, handle: T): void {
  host.events[key] = handle;
  if (typeof host.events.on !== "function") return;
  host.events.on(queryChannel(key), (reply) => {
    if (typeof reply === "function") (reply as (value: T) => void)(handle);
  });
}

export function getSessionHandle<T>(host: SessionHandleHost, key: string): T | undefined {
  const direct = host.events[key];
  if (direct !== undefined) return direct as T;
  if (typeof host.events.emit !== "function") return undefined;
  let found: T | undefined;
  host.events.emit(queryChannel(key), (value: T) => {
    found = value;
  });
  return found;
}
