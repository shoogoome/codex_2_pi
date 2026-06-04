import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
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
    // Pi TUI's truncateToWidth wraps the result with ANSI reset codes,
    // so we compare visibleWidth (not raw .length).
    expect(visibleWidth(bodyLine)).toBeLessThanOrEqual(30);
  });

  it("CJK output / description never overrun visibleWidth (regression: multi task_agent crash)", () => {
    // The output overlay header / body used local s.length truncation
    // which silently overran for CJK content (each char visibleWidth=2,
    // s.length=1) and crashed Pi when the strict width-check rejected
    // the rendered line.
    const cjk =
      "写总体架构文档+生图prompt 这是一个超长的中文描述用来触发宽度计算";
    const task = makeTask({
      description: cjk,
      status: "running",
      startTime: 0,
    });
    const longOutput = `${cjk}\n${cjk.repeat(4)}\n生成🚀报告 ${"x".repeat(200)}`;
    for (const width of [30, 60, 80, 152]) {
      const lines = renderTaskOutputOverlay(task, longOutput, width, 12, {
        theme: NOOP_THEME,
        now: 5000,
      });
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
