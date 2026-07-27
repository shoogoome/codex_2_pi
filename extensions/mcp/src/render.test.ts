import { describe, it, expect } from "vitest";
import {
  buildFoldHint,
  buildHead,
  extractResultText,
  FoldableText,
  renderMcpCall,
  renderMcpResult,
  resolveMaxResultLines,
  summarizeArgs,
  DEFAULT_MAX_ERROR_LINES,
  DEFAULT_MAX_RESULT_LINES,
  type RenderTheme,
} from "./render.js";

// Fake theme that wraps text in visible markers so styling is assertable.
const theme: RenderTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `<b>${text}</b>`,
};

const wide = 120;

describe("summarizeArgs", () => {
  it("returns undefined for absent or empty args", () => {
    expect(summarizeArgs(undefined)).toBeUndefined();
    expect(summarizeArgs(null)).toBeUndefined();
    expect(summarizeArgs({})).toBeUndefined();
    expect(summarizeArgs([])).toBeUndefined();
  });

  it("renders compact one-line JSON", () => {
    expect(summarizeArgs({ pattern: "foo\nbar", limit: 3 })).toBe(
      '{"pattern":"foo\\nbar","limit":3}',
    );
  });

  it("truncates long summaries with an elision marker", () => {
    const summary = summarizeArgs({ q: "x".repeat(500) }, 50);
    expect(summary).toBeDefined();
    expect(summary!.length).toBe(50);
    expect(summary!.endsWith("…")).toBe(true);
  });
});

describe("buildHead", () => {
  it("colors the dot by lifecycle state and bolds the label", () => {
    expect(buildHead("srv:tool", undefined, theme, "pending")).toBe(
      "<dim>●</dim> <b>srv:tool</b>",
    );
    expect(buildHead("srv:tool", undefined, theme, "success")).toBe(
      "<success>●</success> <b>srv:tool</b>",
    );
    expect(buildHead("srv:tool", undefined, theme, "error")).toBe(
      "<error>●</error> <b>srv:tool</b>",
    );
  });

  it("puts the arg summary in parens right after the label", () => {
    expect(buildHead("srv:tool", '{"a":1}', theme, "success")).toBe(
      '<success>●</success> <b>srv:tool</b>(<text>{"a":1}</text>)',
    );
  });
});

describe("extractResultText", () => {
  it("joins text blocks and detects images", () => {
    const { text, hasImage } = extractResultText([
      { type: "text", text: "a" },
      { type: "image", data: "…", mimeType: "image/png" },
      { type: "text", text: "b" },
    ]);
    expect(text).toBe("a\nb");
    expect(hasImage).toBe(true);
  });

  it("handles non-array content", () => {
    expect(extractResultText(undefined)).toEqual({ text: "", hasImage: false });
  });
});

describe("FoldableText", () => {
  it("folds to maxLines visual rows with a hint", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const rows = new FoldableText(text, theme, {
      maxLines: 3,
      expandHint: "ctrl+o to expand",
    }).render(wide);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toBe("line0");
    expect(rows[3]).toContain("… +7 lines");
    expect(rows[3]).toContain("(ctrl+o to expand)");
  });

  it("renders everything when expanded", () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
    const rows = new FoldableText(text, theme, { maxLines: 3, expanded: true }).render(wide);
    expect(rows).toHaveLength(10);
  });

  it("reveals a single hidden row instead of eliding it", () => {
    const text = "a\nb\nc\nd";
    const rows = new FoldableText(text, theme, { maxLines: 3 }).render(wide);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toBe("d");
  });

  it("folds by visual rows, not logical lines (long wrapped lines)", () => {
    // One 300-char logical line wraps into 3 rows at width 100.
    const long = "x".repeat(300);
    const rows = new FoldableText(`${long}\ntail`, theme, {
      maxLines: 2,
      expandHint: "ctrl+o to expand",
    }).render(100);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toContain("… +2 lines");
  });

  it("truncates the head to one row with an overflow marker", () => {
    const head = buildHead("srv:tool", `{"q":"${"x".repeat(300)}"}`, theme, "success");
    const rows = new FoldableText(head, theme, { maxLines: 1, overflowMarker: "…" }).render(60);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("…");
  });
});

describe("renderMcpCall", () => {
  it("renders the pending head one line", () => {
    const rows = renderMcpCall("srv:tool", { a: 1 }, theme, "pending").render(wide);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe('<dim>●</dim> <b>srv:tool</b>(<text>{"a":1}</text>)');
  });
});

describe("renderMcpResult", () => {
  const contentOf = (lines: string[]) => [{ type: "text", text: lines.join("\n") }];

  it("folds long output to the default cap with ⎿ prefix", () => {
    const component = renderMcpResult(
      { content: contentOf(["a", "b", "c", "d", "e", "f"]) },
      { expanded: false },
      theme,
    );
    const rows = component.render(wide);
    expect(rows).toHaveLength(DEFAULT_MAX_RESULT_LINES + 1);
    expect(rows[0]).toBe("<dim>  ⎿  </dim><text>a</text>");
    expect(rows[1]).toBe("     <text>b</text>");
    expect(rows[3]).toContain("… +3 lines");
  });

  it("shows everything when expanded", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const rows = renderMcpResult(
      { content: contentOf(lines) },
      { expanded: true },
      theme,
    ).render(wide);
    expect(rows).toHaveLength(20);
  });

  it("caps error output at the error limit and colors it", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `e${i}`);
    const rows = renderMcpResult(
      { content: contentOf(lines), details: { isError: true } },
      { expanded: false },
      theme,
    ).render(wide);
    expect(rows).toHaveLength(DEFAULT_MAX_ERROR_LINES + 1);
    expect(rows[0]).toContain("<error>e0</error>");
    expect(rows[10]).toContain("… +20 lines");
  });

  it("honors the context error flag too", () => {
    const rows = renderMcpResult(
      { content: contentOf(["boom"]) },
      { expanded: false, isError: true },
      theme,
    ).render(wide);
    expect(rows[0]).toContain("<error>boom</error>");
  });

  it("shows dim (No output) for empty successful output", () => {
    const rows = renderMcpResult(
      { content: [{ type: "text", text: "  \n" }] },
      { expanded: false },
      theme,
    ).render(wide);
    expect(rows).toHaveLength(1);
    // pi's Text pads rows to the render width; match the content prefix.
    expect(rows[0]).toContain("<dim>  ⎿  </dim><dim>(No output)</dim>");
  });

  it("stays blank for image-only results (pi core renders the image)", () => {
    const rows = renderMcpResult(
      { content: [{ type: "image", data: "…", mimeType: "image/png" }] },
      { expanded: false },
      theme,
    ).render(wide);
    expect(rows.join("")).toBe("");
  });

  it("shows a dim running placeholder for partial results", () => {
    const rows = renderMcpResult(
      { content: contentOf(["partial"]) },
      { isPartial: true },
      theme,
    ).render(wide);
    expect(rows.join("\n")).toContain("running…");
  });
});

describe("resolveMaxResultLines", () => {
  it("prefers the MCP-specific env var, then claude-ui's, then the default", () => {
    expect(resolveMaxResultLines({})).toBe(DEFAULT_MAX_RESULT_LINES);
    expect(resolveMaxResultLines({ PI_CLAUDE_UI_MAX_RESULT_LINES: "7" })).toBe(7);
    expect(
      resolveMaxResultLines({ PI_CLAUDE_UI_MAX_RESULT_LINES: "7", PI_MCP_MAX_RESULT_LINES: "5" }),
    ).toBe(5);
    expect(resolveMaxResultLines({ PI_MCP_MAX_RESULT_LINES: "nope" })).toBe(
      DEFAULT_MAX_RESULT_LINES,
    );
    expect(resolveMaxResultLines({ PI_MCP_MAX_RESULT_LINES: "0" })).toBe(
      DEFAULT_MAX_RESULT_LINES,
    );
  });
});

describe("buildFoldHint", () => {
  it("falls back to the literal hint when none is provided", () => {
    expect(buildFoldHint(2, theme)).toBe("     <dim>… +2 lines</dim> (ctrl+o to expand)");
    expect(buildFoldHint(1, theme, "ctrl+o to expand")).toBe(
      "     <dim>… +1 line</dim> (ctrl+o to expand)",
    );
  });
});
