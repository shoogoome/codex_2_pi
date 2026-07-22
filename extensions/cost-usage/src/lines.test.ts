// extensions/cost-usage/src/lines.test.ts
//
// Unit tests for the edit/write diff line-churn parser.

import { describe, expect, it } from "vitest";
import { addChurn, countWriteLines, emptyChurn, parseDiffChurn } from "./lines.js";

describe("parseDiffChurn", () => {
  it("counts + / - lines, excluding +++/--- file headers and @@ hunk headers", () => {
    const diff = [
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " context line",
      "-removed one",
      "-removed two",
      "+added one",
      "+added two",
      "+added three",
      " trailing context",
    ].join("\n");
    expect(parseDiffChurn(diff)).toEqual({ added: 3, removed: 2 });
  });

  it("degrades to {0,0} on malformed / empty / non-string input", () => {
    expect(parseDiffChurn("")).toEqual({ added: 0, removed: 0 });
    expect(parseDiffChurn(undefined)).toEqual({ added: 0, removed: 0 });
    expect(parseDiffChurn(42)).toEqual({ added: 0, removed: 0 });
    expect(parseDiffChurn("no markers here\njust text")).toEqual({ added: 0, removed: 0 });
  });
});

describe("countWriteLines", () => {
  it("counts content lines and ignores a single trailing newline", () => {
    expect(countWriteLines("a\nb\nc")).toBe(3);
    expect(countWriteLines("a\nb\nc\n")).toBe(3);
    expect(countWriteLines("single")).toBe(1);
  });
  it("returns 0 for empty / non-string", () => {
    expect(countWriteLines("")).toBe(0);
    expect(countWriteLines(undefined)).toBe(0);
  });
});

describe("addChurn", () => {
  it("merges deltas immutably and dedupes file paths", () => {
    let acc = emptyChurn();
    acc = addChurn(acc, { added: 3, removed: 1, file: "a.ts" });
    acc = addChurn(acc, { added: 2, removed: 0, file: "a.ts" }); // same file
    acc = addChurn(acc, { added: 4, removed: 2, file: "b.ts" });
    expect(acc.added).toBe(9);
    expect(acc.removed).toBe(3);
    expect(acc.files).toEqual(["a.ts", "b.ts"]);
  });
  it("clamps negative deltas and tolerates missing file", () => {
    let acc = emptyChurn();
    acc = addChurn(acc, { added: -5, removed: -1 });
    expect(acc).toEqual({ added: 0, removed: 0, files: [] });
  });
});
