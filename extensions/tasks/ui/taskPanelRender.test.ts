import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  renderTaskPanel,
  type TaskPanelEntry,
  type TaskPanelTheme,
} from "./taskPanelRender.js";

const NOOP_THEME: TaskPanelTheme = { fg: (_c, t) => t };

function makeEntry(over: Partial<TaskPanelEntry> = {}): TaskPanelEntry {
  return {
    id: "a1",
    type: "local_agent",
    description: "do work",
    status: "running",
    startTime: 0,
    toolCallCount: 0,
    tokenCount: 0,
    ...over,
  };
}

describe("renderTaskPanel", () => {
  it("returns [] when no tasks", () => {
    expect(renderTaskPanel([])).toEqual([]);
  });

  it("non-focused header includes Tasks count + Ctrl+T hint", () => {
    const lines = renderTaskPanel([makeEntry()], {
      width: 80,
      focused: false,
      theme: NOOP_THEME,
      now: 1000,
    });
    expect(lines[0]).toContain("Tasks");
    expect(lines[0]).toContain("(1 running)");
    expect(lines[0]).toContain("Ctrl+T");
  });

  it("focused header includes ↑/↓ select / Enter view hint", () => {
    const lines = renderTaskPanel([makeEntry()], {
      width: 80,
      focused: true,
      theme: NOOP_THEME,
      now: 1000,
    });
    expect(lines[0]).toContain("↑/↓");
    expect(lines[0]).toContain("Enter");
  });

  it("renders single running task with elapsed and tokens", () => {
    const lines = renderTaskPanel(
      [
        makeEntry({
          id: "ax",
          description: "Fix #2",
          status: "running",
          startTime: 0,
          tokenCount: 74000,
        }),
      ],
      {
        width: 100,
        focused: false,
        theme: NOOP_THEME,
        now: 6 * 60 * 1000 + 44 * 1000, // 6m 44s
      },
    );
    const row = lines.find((l) => l.includes("Fix #2"));
    expect(row).toBeDefined();
    expect(row).toContain("○");
    expect(row).toContain("local_agent");
    expect(row).toContain("6m 44s");
    expect(row).toContain("74.0k");
  });

  it("sorts tasks by startTime ascending", () => {
    const lines = renderTaskPanel(
      [
        makeEntry({ id: "a", description: "later", startTime: 200 }),
        makeEntry({ id: "b", description: "first", startTime: 100 }),
        makeEntry({ id: "c", description: "middle", startTime: 150 }),
      ],
      { width: 100, focused: false, theme: NOOP_THEME, now: 1000 },
    );
    const idxFirst = lines.findIndex((l) => l.includes("first"));
    const idxMiddle = lines.findIndex((l) => l.includes("middle"));
    const idxLater = lines.findIndex((l) => l.includes("later"));
    expect(idxFirst).toBeLessThan(idxMiddle);
    expect(idxMiddle).toBeLessThan(idxLater);
  });

  it("highlights selectedTaskId with ▶ prefix", () => {
    const lines = renderTaskPanel(
      [
        makeEntry({ id: "a", description: "alpha", startTime: 0 }),
        makeEntry({ id: "b", description: "beta", startTime: 1 }),
      ],
      {
        width: 100,
        focused: true,
        selectedTaskId: "b",
        theme: NOOP_THEME,
        now: 1000,
      },
    );
    const betaRow = lines.find((l) => l.includes("beta"))!;
    const alphaRow = lines.find((l) => l.includes("alpha"))!;
    expect(betaRow.startsWith("▶ ")).toBe(true);
    expect(alphaRow.startsWith("  ")).toBe(true);
  });

  it("formats elapsed under 60s as Xs", () => {
    const lines = renderTaskPanel(
      [makeEntry({ description: "quick", startTime: 0 })],
      { width: 100, theme: NOOP_THEME, now: 12 * 1000 },
    );
    expect(lines.some((l) => l.includes("12s"))).toBe(true);
  });

  it("formats elapsed for 1m 5s", () => {
    const lines = renderTaskPanel(
      [makeEntry({ description: "med", startTime: 0 })],
      { width: 100, theme: NOOP_THEME, now: 65 * 1000 },
    );
    expect(lines.some((l) => l.includes("1m 5s"))).toBe(true);
  });

  it("formats elapsed for 1h 2m", () => {
    const lines = renderTaskPanel(
      [makeEntry({ description: "long", startTime: 0 })],
      { width: 100, theme: NOOP_THEME, now: (3600 + 120) * 1000 },
    );
    expect(lines.some((l) => l.includes("1h 2m"))).toBe(true);
  });

  it("formats tokens 0 / 100 / 1.5k / 100.0k", () => {
    function tokens(t: number): string {
      const lines = renderTaskPanel(
        [makeEntry({ description: `t${t}`, startTime: 0, tokenCount: t })],
        { width: 200, theme: NOOP_THEME, now: 1000 },
      );
      return lines.find((l) => l.includes(`t${t}`)) ?? "";
    }
    expect(tokens(0)).toContain("0 tokens");
    expect(tokens(100)).toContain("100 tokens");
    expect(tokens(1500)).toContain("1.5k tokens");
    expect(tokens(100000)).toContain("100.0k tokens");
  });

  it("uses ● for completed and ✗ for failed/killed", () => {
    const lines = renderTaskPanel(
      [
        makeEntry({ id: "a", description: "done", status: "completed" }),
        makeEntry({ id: "b", description: "boom", status: "failed", startTime: 1 }),
        makeEntry({ id: "c", description: "kil", status: "killed", startTime: 2 }),
      ],
      { width: 100, theme: NOOP_THEME, now: 1000 },
    );
    expect(lines.find((l) => l.includes("done"))).toContain("●");
    expect(lines.find((l) => l.includes("boom"))).toContain("✗");
    expect(lines.find((l) => l.includes("kil"))).toContain("✗");
  });

  it("truncates long description to fit width with …", () => {
    const desc = "x".repeat(200);
    const lines = renderTaskPanel(
      [makeEntry({ description: desc, startTime: 0 })],
      { width: 40, theme: NOOP_THEME, now: 1000 },
    );
    const row = lines.find((l) => l.includes("xxx"))!;
    expect(row).toBeDefined();
    // Pi TUI's truncateToWidth wraps the result with ANSI reset codes,
    // so we compare the visible width (not raw .length).
    expect(visibleWidth(row)).toBeLessThanOrEqual(40);
    expect(row).toContain("…");
  });

  it("counts only running tasks in non-focused header", () => {
    const lines = renderTaskPanel(
      [
        makeEntry({ id: "a", status: "running" }),
        makeEntry({ id: "b", status: "completed", startTime: 1 }),
        makeEntry({ id: "c", status: "running", startTime: 2 }),
      ],
      { width: 100, focused: false, theme: NOOP_THEME, now: 1000 },
    );
    expect(lines[0]).toContain("(2 running)");
  });

  it("CJK description never overruns visibleWidth budget (regression: multi task_agent crash)", () => {
    // Pi TUI strict-checks rendered line visibleWidth and kills the process
    // if it exceeds the terminal width. Local hand-rolled truncate(s, width)
    // based on s.length silently overran for CJK (each char visibleWidth=2,
    // but s.length=1) → 4 concurrent task_agent with Chinese descriptions
    // crashed the Pi process. This test pins the invariant.
    const tasks: TaskPanelEntry[] = [
      makeEntry({
        id: "t1",
        type: "local_agent",
        description:
          "写总体架构文档+生图prompt 这是一个超长的中文描述用来触发 visibleWidth 计算",
        status: "running",
        startTime: 1000,
      }),
      makeEntry({
        id: "t2",
        type: "local_agent",
        description: "起一个🚀长 emoji 中文 description 用来确认 wide-glyph 也被尊重",
        status: "running",
        startTime: 1001,
      }),
    ];
    for (const width of [40, 60, 80, 100, 152]) {
      const lines = renderTaskPanel(tasks, {
        width,
        focused: true,
        theme: NOOP_THEME,
        now: 2000,
      });
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });
});
