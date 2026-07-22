import { describe, expect, it } from "vitest";
import { hashHookCommand, isTrusted, reduceTrustEntries, TRUST_ENTRY } from "./trust.js";
import type { CommandHook, EntryLike } from "./types.js";

const cmd = (command: string): CommandHook => ({ type: "command", command });

describe("hashHookCommand", () => {
  it("is stable for identical commands", () => {
    expect(hashHookCommand(cmd("echo hi"))).toBe(hashHookCommand(cmd("echo hi")));
  });

  it("changes when the command content changes", () => {
    expect(hashHookCommand(cmd("echo hi"))).not.toBe(hashHookCommand(cmd("echo bye")));
  });

  it("differs across hook types with the same body-ish text", () => {
    const asCommand = hashHookCommand({ type: "command", command: "x" });
    const asHttp = hashHookCommand({ type: "http", url: "x" });
    expect(asCommand).not.toBe(asHttp);
  });

  it("hashes prompt/agent/http by their content", () => {
    expect(hashHookCommand({ type: "prompt", prompt: "p" })).toEqual(
      hashHookCommand({ type: "prompt", prompt: "p" }),
    );
    expect(hashHookCommand({ type: "http", url: "https://a" })).not.toBe(
      hashHookCommand({ type: "http", url: "https://b" }),
    );
  });
});

describe("reduceTrustEntries", () => {
  it("builds a Set of hashes from trust entries on the branch", () => {
    const branch: EntryLike[] = [
      { type: "custom", customType: TRUST_ENTRY, data: { hash: "aaa" } },
      { type: "custom", customType: "other", data: { hash: "zzz" } },
      { type: "message" },
      { type: "custom", customType: TRUST_ENTRY, data: { hash: "bbb" } },
    ];
    const set = reduceTrustEntries(branch);
    expect([...set].sort()).toEqual(["aaa", "bbb"]);
  });

  it("ignores malformed trust entries", () => {
    const branch: EntryLike[] = [
      { type: "custom", customType: TRUST_ENTRY, data: null },
      { type: "custom", customType: TRUST_ENTRY, data: { hash: 42 } },
      { type: "custom", customType: TRUST_ENTRY, data: {} },
    ];
    expect(reduceTrustEntries(branch).size).toBe(0);
  });
});

describe("isTrusted", () => {
  it("reflects replayed trust and re-triggers on content change", () => {
    const hook = cmd("echo hi");
    const set = new Set([hashHookCommand(hook)]);
    expect(isTrusted(set, hook)).toBe(true);
    // Edit the command → hash changes → no longer trusted.
    expect(isTrusted(set, cmd("echo HELLO"))).toBe(false);
  });
});
