// Tests for teammateOverlayRender — pure SessionEntry[] -> string[] for the
// Path Y full-screen overlay. We only test the render contract, not Pi TUI
// concerns.

import { describe, it, expect } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  renderTeammateOverlay,
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
    // header + separator + (height-2) body rows = height total
    expect(lines.length).toBeLessThanOrEqual(height);
    // newest message should be present (last in entries)
    expect(lines.some((l) => l.includes("msg49"))).toBe(true);
    // earliest should be dropped
    expect(lines.some((l) => l.includes("msg0"))).toBe(false);
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
});
