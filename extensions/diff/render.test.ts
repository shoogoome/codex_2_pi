import { describe, it, expect } from "vitest";
import { renderDiffMessage } from "./render.js";

const fakeTheme = {
  fg(_color: string, text: string) { return text; },
  bg(_color: string, text: string) { return text; },
  bold(text: string) { return text; },
  getFgAnsi(_color: string) { return ""; },
  getBgAnsi(_color: string) { return ""; },
};

describe("renderDiffMessage", () => {
  it("returns undefined for empty diff text", () => {
    expect(renderDiffMessage("", { expanded: false }, fakeTheme)).toBeUndefined();
    expect(renderDiffMessage("   ", { expanded: false }, fakeTheme)).toBeUndefined();
  });

  it("returns a Component with render method for valid diff", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old line",
      "+new line",
      " line3",
    ].join("\n");

    const component = renderDiffMessage(diff, { expanded: true }, fakeTheme);
    expect(component).toBeDefined();
    expect(typeof (component as any).render).toBe("function");
  });

  it("renders split view when width is sufficient", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-removed",
      "+added",
      " context2",
    ].join("\n");

    const component = renderDiffMessage(diff, { expanded: true }, fakeTheme);
    expect(component).toBeDefined();

    // Render at a wide width (should trigger split mode)
    const lines = (component as any).render(160);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("renders unified view when width is narrow", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-old",
      "+new",
    ].join("\n");

    const component = renderDiffMessage(diff, { expanded: false }, fakeTheme);
    expect(component).toBeDefined();

    // Render at a narrow width (should fall back to unified or compact)
    const lines = (component as any).render(60);
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.length).toBeGreaterThan(0);
  });

  it("returns a plain text message for non-diff content like 'No changes.'", () => {
    const component = renderDiffMessage("No changes.", { expanded: false }, fakeTheme);
    expect(component).toBeDefined();
    // Should still produce renderable output
    const lines = (component as any).render(80);
    expect(Array.isArray(lines)).toBe(true);
  });
});
