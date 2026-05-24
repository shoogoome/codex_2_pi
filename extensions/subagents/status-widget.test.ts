import { describe, expect, it } from "vitest";
import { formatRunningSubagentWidget } from "./status-widget.js";
import type { SubagentSummary } from "./types.js";

function summary(overrides: Partial<SubagentSummary> = {}): SubagentSummary {
  return {
    id: "agent_1",
    taskName: "worker",
    cwd: "/repo",
    status: "running",
    lastTurnStatus: "none",
    startedAt: 1_000,
    updatedAt: 2_000,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    eventCount: 0,
    recentEvents: [],
    mailboxVersion: 1,
    ...overrides,
  };
}

describe("running subagent widget", () => {
  it("returns undefined when no subagents are active", () => {
    expect(formatRunningSubagentWidget([summary({ status: "idle" })], 5_000)).toBeUndefined();
    expect(formatRunningSubagentWidget([summary({ status: "closed" })], 5_000)).toBeUndefined();
    expect(formatRunningSubagentWidget([summary({ status: "failed" })], 5_000)).toBeUndefined();
  });

  it("renders starting and running subagents in start order", () => {
    expect(
      formatRunningSubagentWidget(
        [
          summary({ id: "agent_2", taskName: "second", status: "running", startedAt: 2_000 }),
          summary({ id: "agent_1", taskName: "first", status: "starting", startedAt: 1_000 }),
        ],
        62_000,
      ),
    ).toEqual([
      "Subagents running (2):",
      "● first — starting — 1m01s",
      "● second — running — 1m00s",
    ]);
  });

  it("includes assistant or error previews when present", () => {
    expect(
      formatRunningSubagentWidget(
        [
          summary({ taskName: "review", lastAssistantPreview: "checking tests" }),
          summary({ taskName: "debug", lastError: "temporary stderr" }),
        ],
        5_000,
      ),
    ).toEqual([
      "Subagents running (2):",
      "● review — running — 4s — checking tests",
      "● debug — running — 4s — Error: temporary stderr",
    ]);
  });

  it("limits long lists and shows overflow count", () => {
    const agents = Array.from({ length: 6 }, (_, index) =>
      summary({ id: `agent_${index + 1}`, taskName: `worker_${index + 1}`, startedAt: index + 1 }),
    );

    expect(formatRunningSubagentWidget(agents, 10_000, { maxRows: 3 })).toEqual([
      "Subagents running (6):",
      "● worker_1 — running — 9s",
      "● worker_2 — running — 9s",
      "● worker_3 — running — 9s",
      "… 3 more running",
    ]);
  });
});
