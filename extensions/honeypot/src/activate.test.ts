import { describe, expect, it } from "vitest";
import { resolveDefaultBundleId } from "./activate.js";

describe("resolveDefaultBundleId", () => {
  it("uses explicit id when provided", () => {
    expect(resolveDefaultBundleId("codex-red-team")).toBe("codex-red-team");
  });

  it("falls back to xsser-codex", () => {
    expect(resolveDefaultBundleId()).toBe("xsser-codex");
  });
});
