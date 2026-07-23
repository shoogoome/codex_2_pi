import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { FoldableText, wrapVisualLines } from "./foldable-text.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "");
}

describe("wrapVisualLines", () => {
  it("wraps a single logical line by terminal width", () => {
    expect(wrapVisualLines("abcdefghijkl", 5)).toEqual(["abcde", "fghij", "kl"]);
  });

  it("keeps every visual row within the requested width for wide text", () => {
    const rows = wrapVisualLines("中文中文中文", 5);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((row) => visibleWidth(row) <= 5)).toBe(true);
  });
});

describe("FoldableText", () => {
  it("folds a huge single line after three visual rows", () => {
    const component = new FoldableText("x".repeat(100), theme, { maxLines: 3 });
    const rows = component.render(10).map((row) => stripAnsi(row));

    expect(rows).toHaveLength(4);
    expect(rows.slice(0, 3)).toEqual([
      "xxxxxxxxxx",
      "xxxxxxxxxx",
      "xxxxxxxxxx",
    ]);
    expect(rows[3]).toContain("+7");
  });

  it("reveals all visual rows when expanded", () => {
    const component = new FoldableText("x".repeat(100), theme, {
      maxLines: 3,
      expanded: true,
    });
    expect(component.render(10)).toHaveLength(10);
  });

  it("truncates an oversized tool summary to one row with an ellipsis", () => {
    const component = new FoldableText("tool " + "x".repeat(100), theme, {
      maxLines: 1,
      overflowMarker: "…",
    });
    const rows = component.render(20).map((row) => stripAnsi(row));

    expect(rows).toHaveLength(1);
    expect(visibleWidth(rows[0] ?? "")).toBeLessThanOrEqual(20);
    expect(rows[0]).toMatch(/…$/);
  });

  it("keeps a two-row tool summary on one row instead of using the +1 exception", () => {
    const component = new FoldableText("x".repeat(30), theme, {
      maxLines: 1,
      overflowMarker: "…",
    });
    expect(component.render(20).map((row) => stripAnsi(row))).toEqual([
      `${"x".repeat(19)}…`,
    ]);
  });

  it("keeps the fold hint itself within a narrow terminal width", () => {
    const component = new FoldableText("x".repeat(100), theme, { maxLines: 3 });
    const rows = component.render(10);
    expect(rows.every((row) => visibleWidth(row) <= 10)).toBe(true);
  });

  it("accounts for columns reserved by the parent renderer", () => {
    const component = new FoldableText("x".repeat(20), theme, {
      maxLines: 10,
      widthOffset: 5,
    });
    expect(component.render(15)).toEqual(["xxxxxxxxxx", "xxxxxxxxxx"]);
  });
});
