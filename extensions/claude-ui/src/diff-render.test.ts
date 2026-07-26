import { describe, expect, it } from "vitest";
import {
  buildDiffLineStrings,
  buildEditSummary,
  computeWordDiff,
  countDiffChanges,
  parseEditDiff,
  parseUnifiedDiff,
  renderWriteResult,
} from "./diff-render.js";
import { LINE_ADDED, LINE_REMOVED, WORD_ADDED, DEFAULT_MAX_DIFF_LINES } from "./constants.js";
import { bgOpen } from "./bg.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

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

describe("buildEditSummary / countDiffChanges", () => {
  it("counts add/del rows and ignores context", () => {
    const parsed = parseEditDiff(["-1 a", "-2 b", "+1 c", " 3 d"].join("\n"));
    expect(countDiffChanges(parsed)).toEqual({ added: 1, removed: 2 });
  });

  it("renders `Added N lines, removed M lines` with bold counts", () => {
    const parsed = parseEditDiff(["-1 a", "+1 b", "+2 c"].join("\n"));
    const summary = buildEditSummary(parsed, theme);
    expect(summary).toContain("Added ");
    expect(summary).toContain("<b>2</b>");
    expect(summary).toContain(", removed ");
    expect(summary).toContain("<b>1</b>");
  });

  it("capitalizes Removed when there are no additions", () => {
    const parsed = parseEditDiff("-1 a");
    expect(buildEditSummary(parsed, theme)).toContain("Removed ");
    expect(buildEditSummary(parsed, theme)).not.toContain("Added");
  });
});

describe("buildDiffLineStrings", () => {
  it("uses full-row backgrounds and keeps the +/- sigil after the line number", () => {
    const diff = ["-42 old", "+42 new", " 43 ctx"].join("\n");
    const rows = buildDiffLineStrings(parseEditDiff(diff), theme);
    const joined = rows.join("\n");
    expect(joined).toContain(bgOpen(LINE_REMOVED));
    expect(joined).toContain(bgOpen(LINE_ADDED));
    // Claude StructuredDiff: right-aligned line number, then sigil, then code
    // (word-level bg escapes may sit between gutter and code — compare visible text).
    expect(stripAnsi(rows[0])).toBe("42 - old");
    expect(stripAnsi(rows[1])).toBe("42 + new");
    // Context rows are dim (fake-theme tagged, not ANSI) — match the visible body.
    expect(rows[2]).toContain("43   ctx");
  });

  it("right-aligns line numbers to the widest number in the diff", () => {
    const diff = ["-9 a", "+100 b"].join("\n");
    const rows = buildDiffLineStrings(parseEditDiff(diff), theme);
    expect(stripAnsi(rows[0])).toBe("  9 - a");
    expect(stripAnsi(rows[1])).toBe("100 + b");
  });

  it("adds a word-level highlight for paired del/add rows", () => {
    const diff = ["-1 abc", "+1 axc"].join("\n");
    const rows = buildDiffLineStrings(parseEditDiff(diff), theme);
    expect(rows.join("\n")).toContain(bgOpen(WORD_ADDED));
  });
});

describe("renderWriteResult", () => {
  it("leads with `Wrote N lines to path` (bold count and path), no green background", () => {
    const rows = (renderWriteResult("one\ntwo", "src/a.txt", undefined, theme) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("Wrote ");
    expect(joined).toContain("<b>2</b>");
    expect(joined).toContain(" lines to ");
    expect(joined).toContain("<b>src/a.txt</b>");
    // Write previews are NOT background-filled (backgrounds are edit-diff only).
    expect(joined).not.toContain(bgOpen(LINE_ADDED));
    // Content is shown under the summary.
    expect(joined).toContain("one");
    expect(joined).toContain("two");
  });
});

describe("folding long diffs", () => {
  const content = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n");

  it("renderWriteResult folds a long preview and shows an expand hint when collapsed", () => {
    const rows = (renderWriteResult(content, "a.txt", undefined, theme, undefined, {
      expanded: false,
    }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("expand");
    expect(joined).toMatch(/\+\d+ lines/);
    // The elided tail is hidden.
    expect(joined).not.toContain("row 60");
    // The summary stays visible above the fold.
    expect(joined).toContain("Wrote ");
  });

  it("renderWriteResult renders the full preview and no hint when expanded", () => {
    const rows = (renderWriteResult(content, "a.txt", undefined, theme, undefined, {
      expanded: true,
    }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 60");
    expect(joined).not.toContain("expand");
  });

  it("defaults the collapsed diff cap to DEFAULT_MAX_DIFF_LINES (10, Claude MAX_LINES_TO_RENDER)", () => {
    // 20 rows, no explicit maxLines → diff default of 10 applies.
    const twenty = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = (renderWriteResult(twenty, "a.txt", undefined, theme, undefined, {
      expanded: false,
    }) as {
      render(w: number): string[];
    }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 10"); // last shown content row
    expect(joined).not.toContain("row 11"); // first hidden row
    expect(joined).toContain(`+${20 - DEFAULT_MAX_DIFF_LINES} lines`);
  });

  it("lets the caller pin an explicit diff cap (env-resolved value wins over the default)", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `row ${i + 1}`).join("\n");
    const rows = (renderWriteResult(twenty, "a.txt", undefined, theme, undefined, {
      expanded: false,
      maxLines: 5,
    }) as { render(w: number): string[] }).render(2000);
    const joined = rows.join("\n");
    expect(joined).toContain("row 5");
    expect(joined).not.toContain("row 6");
    expect(joined).toContain("+15 lines");
  });
});
