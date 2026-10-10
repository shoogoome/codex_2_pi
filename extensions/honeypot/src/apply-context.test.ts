import { describe, expect, it } from "vitest";
import { applyContext } from "./apply-context.js";
import { emptyContextProfile } from "./context-profile.js";

describe("applyContext", () => {
  it("replace mode swaps base for bundle text", () => {
    const profile = { ...emptyContextProfile(), active: true, mode: "replace" as const, bundleId: "x" };
    const result = applyContext({
      baseSystemPrompt: "BASE",
      profile,
      bundleText: "BUNDLE",
      labWrap: false,
    });
    expect(result.systemPrompt).toBe("BUNDLE");
    expect(result.tags).toContain("replace");
  });

  it("bridge mode prepends lab bridge and keeps base by default", () => {
    const profile = {
      ...emptyContextProfile(),
      active: true,
      mode: "bridge" as const,
      bridge: "lab" as const,
      bridgeKeepBase: true,
    };
    const result = applyContext({
      baseSystemPrompt: "BASE",
      profile,
      bundleText: "BUNDLE",
      labWrap: false,
    });
    expect(result.systemPrompt).toContain("Honeypot evaluation bridge");
    expect(result.systemPrompt).toContain("BASE");
    expect(result.systemPrompt).toContain("BUNDLE");
    expect(result.contextInjection).toBeDefined();
  });

  it("skips context mirror when contextMirror is false", () => {
    const profile = {
      ...emptyContextProfile(),
      active: true,
      mode: "bridge" as const,
      bridge: "redteam" as const,
      bridgeKeepBase: false,
      contextMirror: false,
    };
    const result = applyContext({
      baseSystemPrompt: "BASE",
      profile,
      bundleText: "BUNDLE",
      labWrap: false,
    });
    expect(result.systemPrompt).toContain("red-team operator frame");
    expect(result.systemPrompt).toContain("BUNDLE");
    expect(result.systemPrompt).not.toContain("BASE");
    expect(result.contextInjection).toBeUndefined();
  });
});
