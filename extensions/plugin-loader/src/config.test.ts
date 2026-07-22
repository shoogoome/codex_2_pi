import { describe, it, expect } from "vitest";
import { reduceToggles, isEnabled, PLUGIN_TOGGLE_ENTRY } from "./config.js";
import type { EntryLike } from "./types.js";

function toggle(name: string, enabled: boolean): EntryLike {
  return { type: "custom", customType: PLUGIN_TOGGLE_ENTRY, data: { name, enabled } };
}

describe("reduceToggles", () => {
  it("last entry wins for a given plugin", () => {
    const entries: EntryLike[] = [
      toggle("a", false),
      toggle("b", false),
      toggle("a", true),
    ];
    const map = reduceToggles(entries);
    expect(map.get("a")).toBe(true);
    expect(map.get("b")).toBe(false);
  });

  it("ignores unrelated and malformed entries", () => {
    const entries: EntryLike[] = [
      { type: "message" },
      { type: "custom", customType: "other", data: { name: "a", enabled: false } },
      { type: "custom", customType: PLUGIN_TOGGLE_ENTRY, data: { name: "a" } },
      { type: "custom", customType: PLUGIN_TOGGLE_ENTRY, data: { enabled: true } },
      { type: "custom", customType: PLUGIN_TOGGLE_ENTRY, data: "bad" },
    ];
    expect(reduceToggles(entries).size).toBe(0);
  });
});

describe("isEnabled", () => {
  it("defaults to enabled when no toggle recorded", () => {
    expect(isEnabled("x", new Map())).toBe(true);
  });

  it("honors an explicit disable", () => {
    const map = reduceToggles([toggle("x", false)]);
    expect(isEnabled("x", map)).toBe(false);
  });

  it("honors an explicit re-enable", () => {
    const map = reduceToggles([toggle("x", false), toggle("x", true)]);
    expect(isEnabled("x", map)).toBe(true);
  });
});
