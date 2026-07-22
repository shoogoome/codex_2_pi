// extensions/context-pipeline/src/summaryPrompt.test.ts
import { describe, it, expect } from "vitest";
import { NINE_SECTION_INSTRUCTIONS, stripAnalysis } from "./summaryPrompt.js";

describe("NINE_SECTION_INSTRUCTIONS", () => {
  it("contains all nine section titles", () => {
    const titles = [
      "Primary Request",
      "Key Concepts",
      "Files and Code",
      "Errors and Fixes",
      "Problem Solving",
      "All User Messages",
      "Pending Tasks",
      "Current Work",
      "Next Step",
    ];
    for (const t of titles) expect(NINE_SECTION_INSTRUCTIONS).toContain(t);
  });

  it("requires an analysis draft and a summary block", () => {
    expect(NINE_SECTION_INSTRUCTIONS).toContain("<analysis>");
    expect(NINE_SECTION_INSTRUCTIONS).toContain("<summary>");
  });
});

describe("stripAnalysis", () => {
  it("removes a closed analysis block and keeps the rest", () => {
    const input = "<analysis>scratch thoughts</analysis>\nPrimary Request: do X.";
    const out = stripAnalysis(input);
    expect(out).not.toContain("scratch thoughts");
    expect(out).toContain("Primary Request: do X.");
  });

  it("returns the inner summary when a summary block is present", () => {
    const input =
      "<analysis>draft</analysis>\n<summary>1. Primary Request: real content</summary>";
    const out = stripAnalysis(input);
    expect(out).toBe("1. Primary Request: real content");
    expect(out).not.toContain("draft");
  });

  it("is case-insensitive and spans newlines (dotall)", () => {
    const input = "<ANALYSIS>\nline1\nline2\n</ANALYSIS>\nFinal text";
    const out = stripAnalysis(input);
    expect(out).toBe("Final text");
  });

  it("tolerates an unclosed analysis tag", () => {
    const input = "prefix\n<analysis>\nnever closed thoughts to end";
    const out = stripAnalysis(input);
    expect(out).toBe("prefix");
  });

  it("handles empty/null-ish input", () => {
    expect(stripAnalysis("")).toBe("");
    // @ts-expect-error runtime tolerance test
    expect(stripAnalysis(undefined)).toBe("");
  });
});
