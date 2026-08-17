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

  it("pads rows to full width, keeping a trailing bg reset last (diff bars)", () => {
    const bgReset = "\x1b[49m";
    const bgOpenSeq = "\x1b[48;2;34;92;43m";
    const component = new FoldableText(`${bgOpenSeq}code${bgReset}`, theme, {
      maxLines: 5,
      padRowsToWidth: true,
    });
    const rows = component.render(20);
    expect(rows).toHaveLength(1);
    // 16 spaces of padding are inserted BEFORE the bg reset so the bar is solid.
    expect(rows[0]).toBe(`${bgOpenSeq}code${" ".repeat(16)}${bgReset}`);
  });

  it("pads plain rows with trailing spaces when padRowsToWidth is on", () => {
    const component = new FoldableText("ab", theme, {
      maxLines: 5,
      padRowsToWidth: true,
    });
    expect(component.render(6)).toEqual([`ab${" ".repeat(4)}`]);
  });

  it("reuses the fully rendered rows when width and fold state are unchanged", () => {
    const component = new FoldableText("one\ntwo", theme, {
      maxLines: 5,
      padRowsToWidth: true,
    });

    const first = component.render(10);
    expect(component.render(10)).toBe(first);

    component.invalidate();
    const afterInvalidate = component.render(10);
    expect(afterInvalidate).not.toBe(first);
    expect(afterInvalidate).toEqual(first);
  });

  it("refreshes the final cache when mutable fold options change", () => {
    const options = { maxLines: 1, expanded: false, padRowsToWidth: true };
    const component = new FoldableText("one\ntwo\nthree", theme, options);
    const collapsed = component.render(10);

    options.expanded = true;
    const expanded = component.render(10);

    expect(expanded).not.toBe(collapsed);
    expect(expanded.map((row) => row.trimEnd())).toEqual(["one", "two", "three"]);
  });
});
