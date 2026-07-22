import { describe, expect, it } from "vitest";
import {
  buildFoldHint,
  buildResultLines,
  buildToolHead,
  foldLines,
  resolveMaxLines,
} from "./tool-gutter.js";
import {
  DEFAULT_MAX_DIFF_LINES,
  DEFAULT_MAX_RESULT_LINES,
  GLYPH_CONNECTOR,
  GLYPH_DOT,
} from "./constants.js";

const theme = {
  fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  bold: (text: string) => `<b>${text}</b>`,
};

describe("buildToolHead", () => {
  it("renders dot gutter + bold name + dim args on one line", () => {
    const head = buildToolHead("bash", "ls -la", theme);
    expect(head).toContain(`${GLYPH_DOT} `);
    expect(head).toContain("<b>bash</b>");
    expect(head).toContain("<dim>ls -la</dim>");
    expect(head).not.toContain("\n");
  });

  it("omits the args segment when there is no summary", () => {
    const head = buildToolHead("read", undefined, theme);
    expect(head).toContain("<b>read</b>");
    expect(head).not.toContain("<dim>");
  });
});

describe("buildResultLines", () => {
  it("prefixes the first line with the ⎿ connector and indents the rest", () => {
    const lines = buildResultLines("first\nsecond", theme);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(GLYPH_CONNECTOR);
    expect(lines[0]).toContain("<dim>first</dim>");
    expect(lines[1].startsWith("     ")).toBe(true);
    expect(lines[1]).toContain("<dim>second</dim>");
  });

  it("returns an empty array for blank output", () => {
    expect(buildResultLines("", theme)).toEqual([]);
    expect(buildResultLines("   \n  ", theme)).toEqual([]);
  });
});

describe("folding long output", () => {
  const longText = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n");

  it("folds to N lines + a single hint line when collapsed", () => {
    const lines = buildResultLines(longText, theme); // expanded defaults to false
    expect(lines).toHaveLength(DEFAULT_MAX_RESULT_LINES + 1);
    const hint = lines[lines.length - 1];
    expect(hint).toContain("expand");
    expect(hint).toContain("ctrl+o");
    expect(hint).toContain(`+${100 - DEFAULT_MAX_RESULT_LINES} lines`);
    // The elided tail is not present.
    expect(lines.join("\n")).not.toContain("line 100");
  });

  it("renders every line and no hint when expanded", () => {
    const lines = buildResultLines(longText, theme, { expanded: true });
    expect(lines).toHaveLength(100);
    expect(lines.join("\n")).toContain("line 100");
    expect(lines.join("\n")).not.toContain("ctrl+o");
  });

  it("does not fold output already within the limit", () => {
    const lines = buildResultLines("a\nb\nc", theme);
    expect(lines).toHaveLength(3);
    expect(lines.join("\n")).not.toContain("expand");
  });

  it("honors a custom maxLines and a pre-styled expand hint", () => {
    const lines = buildResultLines(longText, theme, {
      maxLines: 5,
      expandHint: "<key>C-o</key> to expand",
    });
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain("<key>C-o</key> to expand");
    expect(lines[5]).toContain("+95 lines");
  });

  it("foldLines passes through when expanded or short; hint counts hidden lines", () => {
    const rows = ["r1", "r2", "r3", "r4"];
    expect(foldLines(rows, theme, { expanded: true, maxLines: 2 })).toEqual(rows);
    expect(foldLines(rows, theme, { maxLines: 10 })).toEqual(rows);
    const folded = foldLines(rows, theme, { maxLines: 2 });
    expect(folded).toHaveLength(3);
    expect(folded[2]).toContain("+2 lines");
  });

  it("buildFoldHint singularizes for one hidden line and falls back to ctrl+o", () => {
    expect(buildFoldHint(1, theme)).toContain("+1 line");
    expect(buildFoldHint(1, theme)).not.toContain("+1 lines");
    expect(buildFoldHint(3, theme)).toContain("ctrl+o to expand");
  });

  it("shows the overflow line directly when exactly one would be hidden (Claude terminal.ts detail)", () => {
    // 4 lines, default cap 3 → 1 hidden → reveal it, no "+1 line" hint.
    const lines = buildResultLines("a\nb\nc\nd", theme);
    expect(lines).toHaveLength(4);
    expect(lines.join("\n")).not.toContain("expand");
    expect(lines[3]).toContain("<dim>d</dim>");
  });

  it("foldLines returns cap+1 lines and no hint when only one line overflows", () => {
    const rows = ["r1", "r2", "r3", "r4"];
    const folded = foldLines(rows, theme, { maxLines: 3 });
    expect(folded).toEqual(rows);
    expect(folded.join("\n")).not.toContain("expand");
    // But two-line overflow keeps the standard hint.
    const two = foldLines([...rows, "r5"], theme, { maxLines: 3 });
    expect(two).toHaveLength(4);
    expect(two[3]).toContain("+2 lines");
  });
});

describe("resolveMaxLines env override", () => {
  it("defaults to the Claude-aligned constants when env is empty", () => {
    expect(resolveMaxLines({})).toEqual({
      result: DEFAULT_MAX_RESULT_LINES,
      diff: DEFAULT_MAX_DIFF_LINES,
    });
  });

  it("honors positive integer overrides for both caps", () => {
    expect(
      resolveMaxLines({
        PI_CLAUDE_UI_MAX_RESULT_LINES: "20",
        PI_CLAUDE_UI_MAX_DIFF_LINES: "40",
      }),
    ).toEqual({ result: 20, diff: 40 });
  });

  it("falls back to defaults for zero / negative / decimal / garbage values", () => {
    expect(resolveMaxLines({ PI_CLAUDE_UI_MAX_RESULT_LINES: "0" }).result).toBe(
      DEFAULT_MAX_RESULT_LINES,
    );
    expect(resolveMaxLines({ PI_CLAUDE_UI_MAX_RESULT_LINES: "-5" }).result).toBe(
      DEFAULT_MAX_RESULT_LINES,
    );
    expect(resolveMaxLines({ PI_CLAUDE_UI_MAX_DIFF_LINES: "3.5" }).diff).toBe(
      DEFAULT_MAX_DIFF_LINES,
    );
    expect(resolveMaxLines({ PI_CLAUDE_UI_MAX_DIFF_LINES: "abc" }).diff).toBe(
      DEFAULT_MAX_DIFF_LINES,
    );
  });

  it("resolves each cap independently", () => {
    const only = resolveMaxLines({ PI_CLAUDE_UI_MAX_RESULT_LINES: "7" });
    expect(only.result).toBe(7);
    expect(only.diff).toBe(DEFAULT_MAX_DIFF_LINES);
  });
});
