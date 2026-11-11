import { describe, expect, it, vi } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { COORDINATOR_PREVIEW_LINES, renderCoordinatorCall, renderCoordinatorResult } from "./render.js";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  keyHint: (action: string, description: string) => `${action === "app.tools.expand" ? "ctrl+o" : action} ${description}`,
}));

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;
const collapsed = { expanded: false, isPartial: false };
const textResult = (text: string) => ({ content: [{ type: "text", text }], details: { retained: true } });

describe("coordinator task rendering", () => {
  it("caps wrapped single-line JSON to eight content rows and one native expansion hint", () => {
    const result = textResult(JSON.stringify({ objective: "长字段".repeat(500) }));
    const before = JSON.stringify(result);
    const rows = renderCoordinatorResult(result, collapsed, theme).render(40);
    expect(rows).toHaveLength(COORDINATOR_PREVIEW_LINES + 1);
    expect(rows.at(-1)).toContain("ctrl+o");
    expect(rows.every(row => visibleWidth(row) <= 40)).toBe(true);
    expect(JSON.stringify(result)).toBe(before);
  });

  it("expands the complete original content without truncating details or text", () => {
    const result = textResult(JSON.stringify(Array.from({ length: 30 }, (_, id) => ({ id, objective: "验收" }))));
    const expanded = renderCoordinatorResult(result, { ...collapsed, expanded: true }, theme).render(40);
    expect(expanded).toEqual(new Text(result.content[0].text, 0, 0).render(40));
    expect(expanded.length).toBeGreaterThan(COORDINATOR_PREVIEW_LINES);
  });

  it("handles multiline output, narrow terminals, resize and invalidation", () => {
    const result = textResult(Array.from({ length: 20 }, (_, id) => `${id}: 中文👩‍💻abcdef`).join("\n"));
    const component = renderCoordinatorResult(result, collapsed, theme);
    for (const width of [2, 7, 60, 3]) {
      const rows = component.render(width);
      expect(rows.length).toBeLessThanOrEqual(COORDINATOR_PREVIEW_LINES + 1);
      expect(rows.every(row => visibleWidth(row) <= width)).toBe(true);
      component.invalidate();
      expect(component.render(width)).toEqual(rows);
    }
  });

  it("keeps calls on one row and never prints contracts or patches", () => {
    const args = { action: "create", task_id: "x".repeat(200), contract: { objective: "SECRET_CONTRACT" } };
    const component = renderCoordinatorCall(args, theme);
    expect(component.render(30)).toHaveLength(1);
    expect(visibleWidth(component.render(30)[0])).toBeLessThanOrEqual(30);
    expect(component.render(1000).join("\n")).not.toContain("SECRET_CONTRACT");
  });

  it("handles empty, partial and short list results without expansion hints", () => {
    expect(renderCoordinatorResult(textResult(""), collapsed, theme).render(80).map(row => row.trimEnd())).toEqual(["(no output)"]);
    expect(renderCoordinatorResult(textResult(""), { ...collapsed, isPartial: true }, theme).render(80).map(row => row.trimEnd())).toEqual(["Updating task…"]);
    expect(renderCoordinatorResult(textResult("[]"), collapsed, theme).render(80).map(row => row.trimEnd())).toEqual(["[]"]);
  });

  it("shows error text in the native error color in collapsed and expanded views", () => {
    const fg = vi.fn((_color: string, text: string) => text);
    const errorTheme = { ...theme, fg } as Theme;
    const result = textResult('{"error":"Error: task_id is required"}');
    for (const expanded of [false, true]) {
      const rows = renderCoordinatorResult(result, { ...collapsed, expanded }, errorTheme, true).render(100);
      expect(rows.join("\n")).toContain("task_id is required");
    }
    expect(fg).toHaveBeenCalledWith("error", result.content[0].text);
  });
});
