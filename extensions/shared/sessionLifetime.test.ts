import { describe, expect, it } from "vitest";
import { createSessionLifetime, getSessionLifetime } from "./sessionLifetime.js";

function facadePair() {
  const handlers = new Map<string, Set<(data: unknown) => unknown>>();
  const facade = () => ({
    events: {
      on(channel: string, handler: (data: unknown) => unknown) {
        const group = handlers.get(channel) ?? new Set();
        group.add(handler);
        handlers.set(channel, group);
      },
      emit(channel: string, data: unknown) {
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
    },
  });
  return [facade(), facade()] as const;
}

describe("session lifetime", () => {
  it("starts live in the factory without SDK lifecycle events", () => {
    expect(createSessionLifetime().capture().isActive()).toBe(true);
  });

  it("never revives a captured token when a session restarts", () => {
    const lifetime = createSessionLifetime();
    const first = lifetime.capture();
    lifetime.close();
    expect(first.isActive()).toBe(false);
    lifetime.restart();
    expect(first.isActive()).toBe(false);
    expect(lifetime.capture().isActive()).toBe(true);
  });

  it("shares late-installed worker guards across extension facades", () => {
    const [asyncHost, workerHost] = facadePair();
    const token = getSessionLifetime(asyncHost).capture();
    let open = true;
    getSessionLifetime(workerHost).setOwnerGuard(() => open);
    expect(token.isActive()).toBe(true);
    open = false;
    // No events/query after disposal: the token reads only captured closures.
    asyncHost.events.emit = () => { throw new Error("stale API"); };
    expect(token.isActive()).toBe(false);
  });

  it("closing one owner does not close another owner", () => {
    const first = createSessionLifetime();
    const other = createSessionLifetime();
    first.close();
    expect(first.capture().owner).not.toBe(other.capture().owner);
    expect(other.capture().isActive()).toBe(true);
  });
});
