import { describe, it, expect } from "vitest";
import {
  renderTaskOutputOverlay,
  type TaskOutputOverlayTheme,
} from "./taskOutputOverlayRender.js";
import type { TaskPanelEntry } from "./taskPanelRender.js";

const NOOP_THEME: TaskOutputOverlayTheme = { fg: (_c, t) => t };

function makeTask(over: Partial<TaskPanelEntry> = {}): TaskPanelEntry {
  return {
    id: "a1",
    type: "local_agent",
    description: "Fix #2",
    status: "running",
    startTime: 0,
    tokenCount: 0,
    toolCallCount: 0,
    ...over,
  };
}

describe("renderTaskOutputOverlay", () => {
  it("emits exactly `height` rows", () => {
    const lines = renderTaskOutputOverlay(makeTask(), "", 80, 10, {
      theme: NOOP_THEME,
      now: 1000,
    });
    expect(lines.length).toBe(10);
  });

  it("returns [] for height <= 0", () => {
    expect(renderTaskOutputOverlay(makeTask(), "x", 80, 0, { theme: NOOP_THEME })).toEqual([]);
  });

  it("empty output renders (no output yet) placeholder", () => {
    const lines = renderTaskOutputOverlay(makeTask(), "", 80, 6, {
      theme: NOOP_THEME,
      now: 1000,
    });
    expect(lines.some((l) => l.includes("(no output yet)"))).toBe(true);
  });

  it("header includes description, status, elapsed, Esc hint", () => {
    const lines = renderTaskOutputOverlay(
      makeTask({ description: "Fix #2", status: "running", startTime: 0 }),
      "",
      80,
      6,
      { theme: NOOP_THEME, now: 5 * 1000 },
    );
    expect(lines[0]).toContain("Fix #2");
    expect(lines[0]).toContain("running");
    expect(lines[0]).toContain("5s");
    expect(lines[0]).toContain("Esc");
  });

  it("preserves only last height-2 lines for long output", () => {
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) lines.push(`line-${i}`);
    const out = renderTaskOutputOverlay(
      makeTask(),
      lines.join("\n"),
      80,
      6, // header + sep + 4 body
      { theme: NOOP_THEME, now: 1000 },
    );
    expect(out.length).toBe(6);
    // 4 body lines (height 6 - header - separator = 4 lines)
    expect(out.find((l) => l.includes("line-99"))).toBeDefined();
    expect(out.find((l) => l.includes("line-96"))).toBeDefined();
    // earlier lines truncated
    expect(out.find((l) => l.includes("line-0"))).toBeUndefined();
  });

  it("truncates lines wider than width-2 with …", () => {
    const longLine = "x".repeat(200);
    const out = renderTaskOutputOverlay(makeTask(), longLine, 30, 6, {
      theme: NOOP_THEME,
      now: 1000,
    });
    const bodyLine = out.find((l) => l.includes("xxx"))!;
    expect(bodyLine).toBeDefined();
    expect(bodyLine.length).toBeLessThanOrEqual(30);
  });
});
