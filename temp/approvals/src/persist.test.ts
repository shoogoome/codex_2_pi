import { describe, it, expect } from "vitest";
import {
  APPROVALS_MODE_ENTRY,
  APPROVALS_RULE_ENTRY,
  coerceRule,
  type EntryLike,
  extractMode,
  reduceRuleEntries,
} from "./persist.js";
import type { Rule } from "./types.js";

function ruleEntry(data: unknown): EntryLike {
  return { type: "custom", customType: APPROVALS_RULE_ENTRY, data };
}
function modeEntry(mode: string): EntryLike {
  return { type: "custom", customType: APPROVALS_MODE_ENTRY, data: { mode } };
}

describe("coerceRule", () => {
  it("accepts a valid rule", () => {
    expect(coerceRule({ effect: "allow", tool: "write" })).toEqual({ effect: "allow", tool: "write" });
  });
  it("rejects bad effect or empty body", () => {
    expect(coerceRule({ effect: "nope", tool: "x" })).toBeNull();
    expect(coerceRule({ effect: "allow" })).toBeNull();
    expect(coerceRule(null)).toBeNull();
  });
});

describe("reduceRuleEntries", () => {
  const defaults: Rule[] = [{ effect: "deny", tool: "danger" }];

  it("replays add ops over defaults", () => {
    const entries = [
      ruleEntry({ op: "add", rule: { effect: "allow", tool: "write" } }),
      ruleEntry({ op: "add", rule: { effect: "ask", bashPrefix: "git commit" } }),
    ];
    const out = reduceRuleEntries(entries, defaults);
    expect(out).toHaveLength(3);
    expect(out[1]).toEqual({ effect: "allow", tool: "write" });
  });

  it("applies remove by 1-based index", () => {
    const entries = [
      ruleEntry({ op: "add", rule: { effect: "allow", tool: "write" } }),
      ruleEntry({ op: "remove", index: 2 }),
    ];
    const out = reduceRuleEntries(entries, defaults);
    expect(out).toEqual([{ effect: "deny", tool: "danger" }]);
  });

  it("ignores foreign and malformed entries", () => {
    const entries: EntryLike[] = [
      { type: "message" },
      { type: "custom", customType: "other", data: { op: "add", rule: { effect: "allow", tool: "x" } } },
      ruleEntry({ op: "add", rule: { effect: "bogus" } }),
    ];
    expect(reduceRuleEntries(entries, defaults)).toEqual(defaults);
  });

  it("does not mutate the defaults array", () => {
    const d = [{ effect: "deny", tool: "danger" } as Rule];
    reduceRuleEntries([ruleEntry({ op: "add", rule: { effect: "allow", tool: "y" } })], d);
    expect(d).toHaveLength(1);
  });
});

describe("extractMode", () => {
  it("last mode entry wins", () => {
    const entries = [modeEntry("bypass"), modeEntry("acceptEdits")];
    expect(extractMode(entries, "default")).toBe("acceptEdits");
  });
  it("falls back when no entry", () => {
    expect(extractMode([{ type: "message" }], "bypass")).toBe("bypass");
  });
  it("ignores invalid mode values", () => {
    expect(extractMode([modeEntry("weird")], "default")).toBe("default");
  });
});
