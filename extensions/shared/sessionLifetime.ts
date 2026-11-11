import { attachSessionHandle, getSessionHandle, type SessionHandleHost } from "./sessionHandle.js";

const KEY = "__pi_session_lifetime_v1__";

/** Plain closure only: safe to read after the SDK has invalidated its Pi API. */
export interface SessionLifetimeToken {
  readonly owner: symbol;
  readonly generation: number;
  isActive(): boolean;
}

export interface SessionLifetime {
  readonly owner: symbol;
  capture(): SessionLifetimeToken;
  restart(): void;
  close(): void;
  /** Late-installed worker guard also applies to already captured tokens. */
  setOwnerGuard(isOpen: () => boolean): void;
}

export function createSessionLifetime(): SessionLifetime {
  const owner = Symbol("session-owner");
  let generation = 0;
  let open = true;
  let isOwnerOpen = () => true;
  return {
    owner,
    capture() {
      const capturedGeneration = generation;
      return {
        owner,
        generation: capturedGeneration,
        isActive: () => open && generation === capturedGeneration && isOwnerOpen(),
      };
    },
    restart() {
      generation++;
      open = true;
    },
    close() { open = false; },
    setOwnerGuard(guard) { isOwnerOpen = guard; },
  };
}

/** Create in the factory: SDK children need not emit session_start/shutdown. */
export function getSessionLifetime(host: SessionHandleHost): SessionLifetime {
  // Some minimal extension test hosts do not implement the shared EventBus.
  if (!host.events) return createSessionLifetime();
  const existing = getSessionHandle<SessionLifetime>(host, KEY);
  if (existing) return existing;
  const lifetime = createSessionLifetime();
  attachSessionHandle(host, KEY, lifetime);
  return lifetime;
}
