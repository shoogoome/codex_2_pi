import { describe, it, expect, beforeEach } from "vitest";
import {
  registerLeaderChannel,
  unregisterLeaderChannel,
  getLeaderChannel,
  _resetLeaderBridgeForTest,
  type LeaderChannel,
} from "./leaderBridge.js";
import type { LeaderNotificationDetails } from "./types.js";

function makeChannel(): { ch: LeaderChannel; calls: Array<{ details: LeaderNotificationDetails; triggerTurn: boolean }> } {
  const calls: Array<{ details: LeaderNotificationDetails; triggerTurn: boolean }> = [];
  const ch: LeaderChannel = {
    deliver(details, triggerTurn) {
      calls.push({ details, triggerTurn });
    },
  };
  return { ch, calls };
}

const msg = (agentId: string, body: string): LeaderNotificationDetails => ({
  kind: "message",
  agentId,
  to: "leader",
  body,
});

describe("leaderBridge — process-global registry", () => {
  beforeEach(() => {
    _resetLeaderBridgeForTest();
  });

  it("getLeaderChannel returns undefined when nothing registered", () => {
    expect(getLeaderChannel()).toBeUndefined();
  });

  it("registers a channel by sessionId and getLeaderChannel returns it", () => {
    const { ch, calls } = makeChannel();
    registerLeaderChannel("s1", ch);
    const got = getLeaderChannel();
    expect(got).toBe(ch);
    got!.deliver(msg("alice@t", "done"), true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.details.kind).toBe("message");
    expect(calls[0]!.triggerTurn).toBe(true);
  });

  it("unregister removes the channel", () => {
    const { ch } = makeChannel();
    registerLeaderChannel("s1", ch);
    unregisterLeaderChannel("s1");
    expect(getLeaderChannel()).toBeUndefined();
  });

  it("unregister of an unknown sessionId is a no-op", () => {
    const { ch } = makeChannel();
    registerLeaderChannel("s1", ch);
    unregisterLeaderChannel("does-not-exist");
    expect(getLeaderChannel()).toBe(ch);
  });

  it("getLeaderChannel returns the most-recently-registered channel", () => {
    const a = makeChannel();
    const b = makeChannel();
    registerLeaderChannel("s1", a.ch);
    registerLeaderChannel("s2", b.ch);
    expect(getLeaderChannel()).toBe(b.ch);
  });

  it("after unregistering the latest, getLeaderChannel falls back to the prior one", () => {
    const a = makeChannel();
    const b = makeChannel();
    registerLeaderChannel("s1", a.ch);
    registerLeaderChannel("s2", b.ch);
    unregisterLeaderChannel("s2");
    expect(getLeaderChannel()).toBe(a.ch);
  });

  it("re-registering the same sessionId replaces the channel and keeps it latest", () => {
    const a = makeChannel();
    const b = makeChannel();
    registerLeaderChannel("s1", a.ch);
    registerLeaderChannel("s1", b.ch);
    expect(getLeaderChannel()).toBe(b.ch);
    unregisterLeaderChannel("s1");
    expect(getLeaderChannel()).toBeUndefined();
  });

  it("bridge state is shared via globalThis symbol (survives module-identity differences)", async () => {
    const { ch } = makeChannel();
    registerLeaderChannel("s1", ch);
    // Re-import through a cache-busting query to simulate a different module
    // realm (jiti loads each extension in its own realm). The globalThis
    // symbol must make the registry shared.
    // @ts-expect-error — query-suffixed dynamic import has no static type.
    const mod = await import("./leaderBridge.js?realm=2");
    expect(mod.getLeaderChannel()).toBe(ch);
  });
});
