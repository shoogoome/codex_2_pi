// extensions/context-pipeline/src/truncateMiddle.test.ts
import { describe, it, expect } from "vitest";
import { truncateMiddle } from "./truncateMiddle.js";

describe("truncateMiddle", () => {
  it("returns content unchanged when within budget", () => {
    const r = truncateMiddle("hello", 10);
    expect(r.content).toBe("hello");
    expect(r.removedChars).toBe(0);
  });

  it("returns unchanged when exactly at budget", () => {
    const r = truncateMiddle("hello", 5);
    expect(r.content).toBe("hello");
    expect(r.removedChars).toBe(0);
  });

  it("keeps head and tail and inserts a marker with truncated count", () => {
    const content = "0123456789ABCDEFGHIJ"; // 20 chars
    const r = truncateMiddle(content, 8);
    // head = floor(8/2)=4, tail = 4, removed = 20 - 8 = 12
    expect(r.removedChars).toBe(12);
    expect(r.content.startsWith("0123")).toBe(true);
    expect(r.content.endsWith("GHIJ")).toBe(true);
    expect(r.content).toContain("12 chars truncated");
  });

  it("reports removedChars = total - budget", () => {
    const content = "x".repeat(1000);
    const r = truncateMiddle(content, 100);
    expect(r.removedChars).toBe(900);
  });

  it("handles budget of 0 (keeps nothing but the marker)", () => {
    const r = truncateMiddle("abcdef", 0);
    expect(r.removedChars).toBe(6);
    expect(r.content).toContain("6 chars truncated");
  });

  it("does not split surrogate pairs (emoji safe)", () => {
    const content = "😀😁😂🤣😃😄😅😆😉😊"; // 10 code points, 20 UTF-16 units
    expect([...content].length).toBe(10);
    const r = truncateMiddle(content, 4);
    // head=2, tail=2, removed=6
    expect(r.removedChars).toBe(6);
    // Result must be valid: no lone surrogates.
    expect(r.content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(r.content).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(r.content.startsWith("😀😁")).toBe(true);
    expect(r.content.endsWith("😉😊")).toBe(true);
  });
});
