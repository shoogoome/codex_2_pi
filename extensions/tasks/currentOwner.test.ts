import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  getOwnerIndex,
  ownerFromSessionFile,
  isOwnerActive,
  setOwnerLivenessProbe,
  _resetOwnerIndexForTest,
  _resetOwnerLivenessProbeForTest,
} from "./currentOwner.js";

beforeEach(() => {
  _resetOwnerIndexForTest();
  _resetOwnerLivenessProbeForTest();
});

afterEach(() => {
  _resetOwnerIndexForTest();
  _resetOwnerLivenessProbeForTest();
});

/**
 * Regression context (measured on a real teammate): AsyncLocalStorage does NOT
 * survive into a teammate sub-session's tool-call realm, so the owner of an
 * `async_bash` child could not be resolved from async context at all — the
 * spawn logged `owner=<none>` and the child leaked past the teammate's kill.
 * Ownership is therefore keyed by the caller's session FILE, which is plain
 * realm-safe data. See extensions/teammate/tools/teammateSendMessage.ts for the
 * same trap being hit by send_message.
 */
describe("owner index", () => {
  it("maps a teammate's session file to its agentId", () => {
    getOwnerIndex().register("/t/alpha/s.jsonl", "alpha@t");
    expect(ownerFromSessionFile("/t/alpha/s.jsonl")).toBe("alpha@t");
  });

  it("returns undefined for the leader (its file is not registered)", () => {
    getOwnerIndex().register("/t/alpha/s.jsonl", "alpha@t");
    expect(ownerFromSessionFile("/leader/session.jsonl")).toBeUndefined();
  });

  it("returns undefined when no owner index exists yet", () => {
    // Team extension never loaded / no teammate ever spawned.
    expect(ownerFromSessionFile("/whatever.jsonl")).toBeUndefined();
  });

  it("returns undefined for an undefined session file (no session)", () => {
    getOwnerIndex().register("/t/alpha/s.jsonl", "alpha@t");
    expect(ownerFromSessionFile(undefined)).toBeUndefined();
  });

  it("unregister stops attributing new tasks to a dead teammate", () => {
    const index = getOwnerIndex();
    index.register("/t/alpha/s.jsonl", "alpha@t");
    index.unregister("/t/alpha/s.jsonl");
    expect(ownerFromSessionFile("/t/alpha/s.jsonl")).toBeUndefined();
  });

  it("ignores empty session-file keys", () => {
    const index = getOwnerIndex();
    index.register("", "alpha@t");
    expect(ownerFromSessionFile("")).toBeUndefined();
  });

  it("keeps one shared index across repeated getOwnerIndex() calls", () => {
    getOwnerIndex().register("/t/a.jsonl", "a@t");
    // Second accessor call must see the same map (the cross-realm contract).
    expect(getOwnerIndex().lookup("/t/a.jsonl")).toBe("a@t");
  });

  it("maps two teammates independently", () => {
    const index = getOwnerIndex();
    index.register("/t/a.jsonl", "a@t");
    index.register("/t/b.jsonl", "b@t");
    expect(ownerFromSessionFile("/t/a.jsonl")).toBe("a@t");
    expect(ownerFromSessionFile("/t/b.jsonl")).toBe("b@t");
  });
});

describe("isOwnerActive", () => {
  it("leader-owned (no owner) always delivers", () => {
    setOwnerLivenessProbe(() => false);
    expect(isOwnerActive(undefined)).toBe(true);
  });

  it("is fail-open when no probe is published", () => {
    expect(isOwnerActive("a@t")).toBe(true);
  });

  it("filters a task whose owner already left the team", () => {
    const members = new Set(["alive@t"]);
    setOwnerLivenessProbe((agentId) => members.has(agentId));
    expect(isOwnerActive("alive@t")).toBe(true);
    expect(isOwnerActive("killed@t")).toBe(false);
  });

  it("is fail-open when the probe throws", () => {
    setOwnerLivenessProbe(() => {
      throw new Error("boom");
    });
    expect(isOwnerActive("a@t")).toBe(true);
  });

  it("any realm reporting alive wins (multi-realm safety)", () => {
    // The teammate extension loads once per session realm; a stale realm's
    // probe must not filter a member another realm knows is alive.
    setOwnerLivenessProbe(() => false); // e.g. a sub-session realm's empty teamStore
    setOwnerLivenessProbe((agentId) => agentId === "a@t"); // leader realm
    expect(isOwnerActive("a@t")).toBe(true);
  });
});
