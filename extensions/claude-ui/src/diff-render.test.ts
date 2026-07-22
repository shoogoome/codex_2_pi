import { describe, expect, it } from "vitest";
import {
  buildDiffLineStrings,
  buildWriteDiffLines,
  computeWordDiff,
  parseEditDiff,
  parseUnifiedDiff,
  renderWriteDiff,
} from "./diff-render.js";
import { LINE_ADDED, LINE_REMOVED, WORD_ADDED, DEFAULT_MAX_DIFF_LINES } from "./constants.js";
import { bgOpen } from "./bg.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

describe("parseEditDiff", () => {
  it("classifies add / del / context / skip lines", () => {
    const diff = ["-42 old line", "+42 new line", " 43 kept line", "    ..."].join(
      "\n",
    );
    const parsed = parseEditDiff(diff);
    expect(parsed.map((line) => line.kind)).toEqual([
      "del",
      "add",
      "context",
      "meta",
    ]);
    expect(parsed[0]).toMatchObject({ kind: "del", lineNo: "42", text: "old line" });
    expect(parsed[1]).toMatchObject({ kind: "add", lineNo: "42", text: "new line" });
    expect(parsed[2]).toMatchObject({ kind: "context", lineNo: "43", text: "kept line" });
  });

  it("is aliased as parseUnifiedDiff", () => {
    expect(parseUnifiedDiff).toBe(parseEditDiff);
  });

  it("returns [] for empty diff", () => {
    expect(parseEditDiff("")).toEqual([]);
  });
});

describe("computeWordDiff", () => {
  it("finds the changed middle span for a del/add pair", () => {
    const wd = computeWordDiff("if (t.expired) return null", "if (!t || t.expired) return null");
    expect(wd.prefix).toBe("if (");
    expect(wd.suffix).toBe("t.expired) return null");
    expect(wd.delMiddle).toBe("");
    expect(wd.addMiddle).toBe("!t || ");
  });

  it("handles fully-different strings", () => {
    const wd = computeWordDiff("abc", "xyz");
    expect(wd.prefix).toBe("");
    expect(wd.suffix).toBe("");
    expect(wd.delMiddle).toBe("abc");
    expect(wd.addMiddle).toBe("xyz");
  });
});

describe("buildDiffLineStrings", () => {
  it("uses integer row backgrounds and never emits literal +/-", () => {
    const diff = ["-42 old", "+42 new", " 43 ctx"].join("\n");
    const rows = buildDiffLineStrings(parseEditDiff(diff), theme);
    const joined = rows.join("\n");
    expect(joined).toContain(bgOpen(LINE_REMOVED));
    expect(joined).toContain(bgOpen(LINE_ADDED));
    // No leading +/- markers survive.
    for (const row of rows) {
      expect(/(^|\n)[+-]/.test(row)).toBe(false);
    }
  });

  it("adds a word-level highlight for paired del/add rows", () => {
    const diff = ["-1 abc", "+1 axc"].join("\n");
    const rows = buildDiffLineStrings(parseEditDiff(diff), theme);
    expect(rows.join("\n")).toContain(bgOpen(WORD_ADDED));
  });

  it("renders write content as an all-added green block", () => {
    const lines = buildWriteDiffLines("line one\nline two\n");
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.kind === "add")).toBe(true);
    const rows = buildDiffLineStrings(lines, theme);
    const joined = rows.join("\n");
    expect(joined).toContain(bgOpen(LINE_ADDED));
    expect(joined).not.toContain(bgOpen(LINE_REMOVED));
    expect(joined).not.toMatch(/[+-]line/);
  });
});

describe("folding long diffs", () => {
  const content = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n");

  it("renderWriteDiff folds a long diff and shows an expand hint when collapsed", () => {
    const rows = (renderWriteDiff(content, theme, undefined, { expanded: false }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("expand");
    expect(joined).toMatch(/\+\d+ lines/);
    // The elided tail is hidden.
    expect(joined).not.toContain("row 60");
  });

  it("renderWriteDiff renders the full diff and no hint when expanded", () => {
    const rows = (renderWriteDiff(content, theme, undefined, { expanded: true }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 60");
    expect(joined).not.toContain("expand");
  });

  it("defaults the collapsed diff cap to DEFAULT_MAX_DIFF_LINES (10, Claude MAX_LINES_TO_RENDER)", () => {
    // 20 rows, no explicit maxLines → diff default of 10 applies.
    const twenty = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = (renderWriteDiff(twenty, theme, undefined, { expanded: false }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 10"); // last shown diff row
    expect(joined).not.toContain("row 11"); // first hidden row
    expect(joined).toContain(`+${20 - DEFAULT_MAX_DIFF_LINES} lines`);
  });

  it("lets the caller pin an explicit diff cap (env-resolved value wins over the default)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = (renderWriteDiff(twenty, theme, undefined, {
      expanded: false,
      maxLines: 5,
    }) as { render(w: number): string[] }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 5");
    expect(joined).not.toContain("row 6");
    expect(joined).toContain("+15 lines");
  });
});
