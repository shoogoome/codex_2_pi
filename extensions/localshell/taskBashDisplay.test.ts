import { describe, expect, it } from "vitest";
import { summarizeTaskBashOutput } from "./taskBashDisplay.js";

describe("summarizeTaskBashOutput", () => {
  it("returns hasMore=false for empty text", () => {
    const r = summarizeTaskBashOutput("");
    expect(r.hasMore).toBe(false);
    expect(r.hiddenCount).toBe(0);
    // For empty text head equals "" (single empty line — nothing to fold).
    expect(r.head).toBe("");
  });

  it("does not fold a single-line text", () => {
    const r = summarizeTaskBashOutput("single line");
    expect(r.hasMore).toBe(false);
    expect(r.head).toBe("single line");
    expect(r.hiddenCount).toBe(0);
  });

  it("does not fold a 2-line text (lines <= HEAD+1)", () => {
    const r = summarizeTaskBashOutput("line1\nline2");
    expect(r.hasMore).toBe(false);
    // No folding ⇒ caller should render full text; head returned as-is.
    expect(r.head).toBe("line1\nline2");
    expect(r.hiddenCount).toBe(0);
  });

  it("folds when there are 3+ lines", () => {
    const r = summarizeTaskBashOutput("line1\nline2\nline3");
    expect(r.hasMore).toBe(true);
    expect(r.head).toBe("line1");
    expect(r.hiddenCount).toBe(2);
  });

  it("handles \\r\\n mixed line endings", () => {
    const r = summarizeTaskBashOutput("first\r\nsecond\r\nthird\r\nfourth");
    expect(r.hasMore).toBe(true);
    expect(r.head).toBe("first");
    expect(r.hiddenCount).toBe(3);
  });

  it("computes hidden count for long output (50 lines ⇒ 49 hidden)", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join("\n");
    const r = summarizeTaskBashOutput(text);
    expect(r.hasMore).toBe(true);
    expect(r.head).toBe("line1");
    expect(r.hiddenCount).toBe(49);
  });
});
