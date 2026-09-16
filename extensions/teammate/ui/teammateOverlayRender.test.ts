// Tests for teammateOverlayRender — pure SessionEntry[] -> string[] for the
// Path Y full-screen overlay. We only test the render contract, not Pi TUI
// concerns.

import { describe, it, expect } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  renderTeammateOverlay,
  teammateViewHeight,
  type TeammateOverlayHeader,
} from "./teammateOverlayRender.js";

const HEADER: TeammateOverlayHeader = {
  identity: {
    agentId: "alice@team1",
    agentName: "alice",
    teamName: "team1",
    agentType: "general-purpose",
  },
  taskCount: 3,
  isIdle: false,
  exitHint: "Esc to exit teammate view",
};

function userEntry(text: string, id = "u1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  } as never;
}

function assistantEntry(text: string, id = "a1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "messages",
      provider: "anthropic",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    },
  } as never;
}

function toolUseEntry(name: string, args: Record<string, unknown>, id = "t1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    message: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tc1", name, arguments: args },
      ],
      api: "messages",
      provider: "anthropic",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    },
  } as never;
}

function toolResultEntry(text: string, id = "r1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    message: {
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 0,
    },
  } as never;
}

function teammateEventEntry(id = "ev1"): SessionEntry {
  return {
    type: "custom_message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    customType: "teammate/event",
    content: "ignored",
    display: false,
  } as never;
}

/** A plain `type:"custom"` state/telemetry record (NOT a custom_message). */
function customEntry(customType: string, id = `c-${customType}`): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    customType,
    data: { bytes: 1 },
  } as never;
}

describe("renderTeammateOverlay", () => {
  it("renders a header line with agentId, turn count, active state, and Esc hint", () => {
    const lines = renderTeammateOverlay(HEADER, [], 80, 24);
    expect(lines[0]).toContain("alice@team1");
    expect(lines[0]).toContain("3");
    expect(lines[0]).toContain("active");
    expect(lines[0]).toContain("Esc to exit teammate view");
  });

  it('renders "(no messages yet)" when entries is empty', () => {
    const lines = renderTeammateOverlay(HEADER, [], 80, 24);
    expect(lines.some((l) => l.includes("(no messages yet)"))).toBe(true);
  });

  it("renders user message with [USER] prefix", () => {
    const lines = renderTeammateOverlay(HEADER, [userEntry("hi there")], 80, 24);
    expect(lines.some((l) => l.includes("[USER]") && l.includes("hi there"))).toBe(true);
  });

  it("renders assistant message with [ASSISTANT] prefix", () => {
    const lines = renderTeammateOverlay(HEADER, [assistantEntry("hello")], 80, 24);
    expect(lines.some((l) => l.includes("[ASSISTANT]") && l.includes("hello"))).toBe(true);
  });

  it("renders tool_use with [TOOL <name>] prefix", () => {
    const lines = renderTeammateOverlay(
      HEADER,
      [toolUseEntry("bash", { cmd: "ls" })],
      80,
      24,
    );
    expect(lines.some((l) => l.includes("[TOOL bash]"))).toBe(true);
  });

  it('filters out customType="teammate/event" entries', () => {
    const lines = renderTeammateOverlay(
      HEADER,
      [teammateEventEntry(), userEntry("only-this")],
      80,
      24,
    );
    expect(lines.some((l) => l.includes("only-this"))).toBe(true);
    expect(lines.some((l) => l.includes("teammate/event"))).toBe(false);
  });

  it("truncates to last height-2 rows when entry list overflows", () => {
    const entries: SessionEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(userEntry(`msg${i}`, `u${i}`));
    }
    const height = 6;
    const lines = renderTeammateOverlay(HEADER, entries, 80, height);
    // header + separator + (height-2) body rows = height total (exact)
    expect(lines.length).toBe(height);
    // newest message should be present (last in entries)
    expect(lines.some((l) => l.includes("msg49"))).toBe(true);
    // earliest should be dropped
    expect(lines.some((l) => l.includes("msg0"))).toBe(false);
    // last row should carry real content, not empty padding
    expect(lines[lines.length - 1]).not.toBe("");
  });

  it("wraps a single line wider than width-2", () => {
    const longText = "x".repeat(200);
    const lines = renderTeammateOverlay(
      HEADER,
      [userEntry(longText)],
      30,
      24,
    );
    // should produce at least 2 wrapped body lines
    const bodyLines = lines.slice(2);
    const wrappedCount = bodyLines.filter((l) => l.includes("x")).length;
    expect(wrappedCount).toBeGreaterThanOrEqual(2);
  });

  it("renders idle state in header when isIdle=true", () => {
    const lines = renderTeammateOverlay(
      { ...HEADER, isIdle: true },
      [],
      80,
      24,
    );
    expect(lines[0]).toContain("idle");
  });

  it("renders separator on line 1", () => {
    const lines = renderTeammateOverlay(HEADER, [], 20, 24);
    // separator should be a row of `─` chars (or similar)
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[1]!.length).toBeLessThanOrEqual(20);
  });

  it("renders tool_result with [TOOL_RESULT] prefix and truncated", () => {
    const longText = "Z".repeat(500);
    const lines = renderTeammateOverlay(
      HEADER,
      [toolResultEntry(longText)],
      80,
      24,
    );
    expect(lines.some((l) => l.includes("[TOOL_RESULT]"))).toBe(true);
  });

  it("pads short content with empty rows so output length === height", () => {
    const lines = renderTeammateOverlay(
      HEADER,
      [userEntry("a"), assistantEntry("b")],
      80,
      20,
    );
    expect(lines.length).toBe(20);
    // header + separator + 2 body lines = 4 non-empty rows; rest must be "".
    expect(lines.slice(4).every((l) => l === "")).toBe(true);
  });

  it("pads with empty rows when entries is empty", () => {
    const lines = renderTeammateOverlay(HEADER, [], 80, 10);
    expect(lines.length).toBe(10);
    expect(lines[0]).toContain("alice@team1");
    expect(lines[1]).toMatch(/^─+$/);
    expect(lines[2]).toContain("(no messages yet)");
    expect(lines.slice(3).every((l) => l === "")).toBe(true);
  });

  it("returns an empty array when height is 0", () => {
    const lines = renderTeammateOverlay(HEADER, [userEntry("hi")], 80, 0);
    expect(lines).toEqual([]);
  });

  // ── theme colour application ──
  // Mock theme wraps each segment with `<color>text</color>` so we can
  // assert exactly which colour token painted which segment without
  // depending on real ANSI escape codes.
  const mockTheme = {
    fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
  };

  it("theme: header carries accent label, text agentId, success stats, dim hint", () => {
    const lines = renderTeammateOverlay(HEADER, [], 80, 24, {
      theme: mockTheme,
    });
    expect(lines[0]).toContain("<accent>▶ teammate:</accent>");
    expect(lines[0]).toContain("<text>alice@team1</text>");
    expect(lines[0]).toContain("<success>[3 turns, active]</success>");
    expect(lines[0]).toContain("<dim>Esc to exit teammate view</dim>");
  });

  it("theme: idle header paints stats with muted colour", () => {
    const lines = renderTeammateOverlay(
      { ...HEADER, isIdle: true },
      [],
      80,
      24,
      { theme: mockTheme },
    );
    expect(lines[0]).toContain("<muted>[3 turns, idle]</muted>");
  });

  it("theme: separator is dim-coloured", () => {
    const lines = renderTeammateOverlay(HEADER, [], 20, 24, {
      theme: mockTheme,
    });
    expect(lines[1]).toMatch(/^<dim>─+<\/dim>$/);
  });

  it("theme: body role prefixes ([USER]/[ASSISTANT]/[TOOL ...]/[TOOL_RESULT]) carry semantic colours", () => {
    const lines = renderTeammateOverlay(
      HEADER,
      [
        userEntry("hi"),
        assistantEntry("hello"),
        toolUseEntry("bash", { cmd: "ls" }),
        toolResultEntry("done"),
      ],
      80,
      24,
      { theme: mockTheme },
    );
    expect(lines.some((l) => l.includes("<accent>[USER]</accent>"))).toBe(true);
    expect(
      lines.some((l) => l.includes("<success>[ASSISTANT]</success>")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("<text>[TOOL bash]</text>"))).toBe(
      true,
    );
    expect(
      lines.some((l) => l.includes("<muted>[TOOL_RESULT]</muted>")),
    ).toBe(true);
  });

  it('theme: "(no messages yet)" placeholder is dimmed', () => {
    const lines = renderTeammateOverlay(HEADER, [], 80, 24, {
      theme: mockTheme,
    });
    expect(
      lines.some((l) => l.includes("<dim>(no messages yet)</dim>")),
    ).toBe(true);
  });

  it("CJK message bodies never overrun visibleWidth (regression: multi task_agent crash)", () => {
    // Long CJK content used to slip through the local wrap()/truncate()
    // helpers (which were s.length-based) and trip Pi TUI's strict width
    // check, killing the whole Pi process when 4 task_agent ran in
    // parallel with Chinese descriptions.
    const cjk = "写总体架构文档+生图prompt 这是一个超长的中文描述用来触发宽度计算";
    const entries: SessionEntry[] = [
      userEntry(cjk, "u-cjk"),
      assistantEntry("生成🚀报告并交叉验证全角字符 / emoji 宽度计算", "a-cjk"),
      toolResultEntry(cjk.repeat(5)),
    ];
    for (const width of [30, 60, 80, 152]) {
      const lines = renderTeammateOverlay(HEADER, entries, width, 24);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  it("drops telemetry custom entries instead of emitting [custom] noise", () => {
    // A real teammate session held 2013 `custom` entries (cost-usage/
    // token-speed/monitor snapshots) against 1133 messages. Rendering one
    // `[custom]` placeholder each buried the conversation under a wall of
    // them — the reported "完全就是一个不可看的样子".
    const telemetry: SessionEntry[] = [
      customEntry("cost-usage/snapshot"),
      customEntry("token-speed/snapshot"),
      customEntry("monitor/metric"),
      customEntry("session-summary"),
    ];
    const lines = renderTeammateOverlay(HEADER, telemetry, 80, 6);
    const body = lines.slice(2).join("\n");
    expect(body).not.toContain("[custom]");
    expect(body).not.toContain("cost-usage");
  });

  it("keeps a non-telemetry custom entry as a single marker", () => {
    const lines = renderTeammateOverlay(HEADER, [customEntry("my-ext/state")], 80, 6);
    expect(lines.join("\n")).toContain("[CUSTOM my-ext/state]");
  });

  it("collapses a multi-line tool result to exactly one row", () => {
    // truncateToWidth only clips columns, so embedded newlines used to expand
    // every one of hundreds of tool results into a full block.
    const json = '{\n  "a": 1,\n  "b": {\n    "c": 2\n  }\n}';
    const lines = renderTeammateOverlay(HEADER, [toolResultEntry(json)], 80, 8);
    const bodyRows = lines.slice(2).filter((l) => l.trim().length > 0);
    expect(bodyRows).toHaveLength(1);
    expect(bodyRows[0]).toContain("[TOOL_RESULT]");
  });

  it("strips real ANSI escapes from tool output and arguments", () => {
    const entries: SessionEntry[] = [
      {
        type: "message",
        id: "r-ansi",
        parentId: null,
        timestamp: "2026-06-04T00:00:00Z",
        message: {
          role: "toolResult",
          toolName: "bash",
          content: [{ type: "text", text: "\u001b[0;36mCOLOURED\u001b[0m done" }],
        },
      } as never,
      toolUseEntry("bash", { command: 'echo "\u001b[31mRED\u001b[0m"' }),
    ];
    const out = renderTeammateOverlay(HEADER, entries, 120, 8).join("\n");
    // The overlay owns colour in this view: no raw escape may survive.
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("[0;36m");
    expect(out).toContain("COLOURED");
  });

  it("reserves the input dock instead of claiming the whole terminal", () => {
    expect(teammateViewHeight(45)).toBeLessThan(45);
    expect(teammateViewHeight(45)).toBeGreaterThan(6);
    // A tiny terminal must not yield a zero/negative view.
    expect(teammateViewHeight(8)).toBeGreaterThanOrEqual(6);
    expect(teammateViewHeight(3)).toBeGreaterThanOrEqual(6);
  });

  it("honours the dock-reserve override", () => {
    expect(teammateViewHeight(60, 20)).toBe(40);
    // An absurd reserve is clamped so the view stays usable.
    expect(teammateViewHeight(60, 999)).toBe(6);
  });
});
