import { describe, expect, it } from "vitest";
import { Box, Text } from "@earendil-works/pi-tui";
import { formatAgentSummary, formatEventSummary, formatToolCallTitle, renderSubagentResult } from "./render.js";
import type { SubagentSummary } from "./types.js";

function textFromComponent(component: Text | Box): string {
  if (component instanceof Text) return component.text;
  return component.children.map((child) => textFromComponent(child as Text | Box)).join("\n");
}

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function summary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: "agent_1",
    taskName: "worker",
    cwd: "/repo",
    status: "idle",
    lastTurnStatus: "completed",
    startedAt: 1,
    updatedAt: 2,
    usage: { turns: 1, input: 10, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
    eventCount: 1,
    recentEvents: [{ kind: "tool_start", timestamp: 2, summary: "bash npm test" }],
    mailboxVersion: 3,
    lastAssistantPreview: "done",
    ...overrides,
  };
}

describe("subagent rendering summaries", () => {
  it("formats tool call titles", () => {
    expect(formatToolCallTitle("spawn_agent", { task_name: "worker", message: "Inspect project" })).toBe("spawn_agent worker — Inspect project");
    expect(formatToolCallTitle("wait_agent", { target: "worker" })).toBe("wait_agent worker");
  });

  it("formats agent summaries", () => {
    expect(formatAgentSummary(summary())).toBe("worker: idle/completed - done");
    expect(formatAgentSummary(summary({ status: "failed", lastError: "boom", lastAssistantPreview: undefined }))).toBe("worker: failed/completed - Error: boom");
  });

  it("formats internal events", () => {
    expect(formatEventSummary({ kind: "tool_start", timestamp: 1, summary: "bash npm test" })).toBe("tool_start: bash npm test");
  });

  it("renders forked session metadata in expanded results", () => {
    const result = {
      content: [{ type: "text" as const, text: "Spawned worker" }],
      details: {
        action: "spawn" as const,
        agents: [summary({ sessionPath: "/tmp/subagent.jsonl", forked: true, status: "running", lastTurnStatus: "none" })],
      },
    };

    const rendered = renderSubagentResult(result, true, theme);

    expect(textFromComponent(rendered)).toContain("forked session: /tmp/subagent.jsonl");
  });
});
