import { describe, expect, it } from "vitest";
import { formatAgentSummary, formatEventSummary, formatToolCallTitle } from "./render.js";
import type { SubagentSummary } from "./types.js";

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
});
