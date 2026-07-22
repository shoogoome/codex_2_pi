import { describe, expect, it } from "vitest";
import { applyHookToConfigText, existingHookKeys, hookKey } from "./mapHooks.js";
import type { ParsedHook } from "./types.js";

const hook = (event: string, command: string, matcher?: string): ParsedHook => ({
  event,
  command,
  hookType: "command",
  matcher,
  origin: "x",
});

describe("hookKey / existingHookKeys", () => {
  it("reads existing triples from {hooks:{...}} text", () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo a" }] }],
        Stop: [{ hooks: [{ type: "command", command: "echo s" }] }],
      },
    });
    const keys = existingHookKeys(text);
    expect(keys.has(hookKey("PreToolUse", "Bash", "echo a"))).toBe(true);
    expect(keys.has(hookKey("Stop", undefined, "echo s"))).toBe(true);
  });

  it("treats empty / malformed text as no existing hooks", () => {
    expect(existingHookKeys("").size).toBe(0);
    expect(existingHookKeys("{ broken").size).toBe(0);
  });
});

describe("applyHookToConfigText", () => {
  it("creates event + matcher group and appends the command", () => {
    const out = applyHookToConfigText("", hook("PreToolUse", "echo a", "Bash"));
    const parsed = JSON.parse(out);
    expect(parsed.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(parsed.hooks.PreToolUse[0].hooks[0]).toEqual({ type: "command", command: "echo a" });
    expect(out.endsWith("\n")).toBe(true);
  });

  it("merges into an existing matcher group rather than duplicating it", () => {
    let text = applyHookToConfigText("", hook("PreToolUse", "echo a", "Bash"));
    text = applyHookToConfigText(text, hook("PreToolUse", "echo b", "Bash"));
    const parsed = JSON.parse(text);
    expect(parsed.hooks.PreToolUse).toHaveLength(1);
    expect(parsed.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command)).toEqual([
      "echo a",
      "echo b",
    ]);
  });

  it("keeps matcher-less and matcher groups separate", () => {
    let text = applyHookToConfigText("", hook("Stop", "echo s"));
    text = applyHookToConfigText(text, hook("Stop", "echo t", "Write"));
    const parsed = JSON.parse(text);
    expect(parsed.hooks.Stop).toHaveLength(2);
  });
});
