import { describe, it, expect } from "vitest";
import { isInProcessTeammateTask, type InProcessTeammateTaskState } from "./types.js";
import { createTaskStateBase } from "../tasks/Task.js";

describe("isInProcessTeammateTask", () => {
  it("returns true for InProcessTeammateTaskState shape", () => {
    const t: InProcessTeammateTaskState = {
      ...createTaskStateBase({
        id: "tabc",
        type: "in_process_teammate",
        description: "researcher",
        outputFile: "/tmp/x",
      }),
      type: "in_process_teammate",
      identity: {
        agentId: "researcher@team1",
        agentName: "researcher",
        teamName: "team1",
        agentType: "general-purpose",
      },
      prompt: "find code",
      sessionFile: "/tmp/researcher.jsonl",
      isIdle: false,
      pendingMessages: [],
      shutdownRequested: false,
      shutdownAcknowledged: false,
      toolCallCount: 0,
      tokenCount: 0,
      turnCount: 0,
    };
    expect(isInProcessTeammateTask(t)).toBe(true);
  });

  it("returns false for other task types", () => {
    expect(isInProcessTeammateTask({ type: "local_agent" })).toBe(false);
    expect(isInProcessTeammateTask(null)).toBe(false);
    expect(isInProcessTeammateTask(undefined)).toBe(false);
    expect(isInProcessTeammateTask("string")).toBe(false);
    expect(isInProcessTeammateTask({})).toBe(false);
  });

  it("TeammateEvent discriminated union — each kind compiles", () => {
    const e1: import("./types.js").TeammateEvent = {
      kind: "team_create",
      teamName: "t1",
      description: "test",
      createdAt: 1,
    };
    const e2: import("./types.js").TeammateEvent = {
      kind: "teammate_spawn",
      identity: {
        agentId: "a@t",
        agentName: "a",
        teamName: "t",
        agentType: "general-purpose",
      },
      sessionFile: "/tmp/x.jsonl",
      initialPrompt: "go",
    };
    const e3: import("./types.js").TeammateEvent = {
      kind: "shutdown_response",
      agentId: "a@t",
      requestId: "r-1",
      approve: true,
    };
    expect(e1.kind).toBe("team_create");
    expect(e2.kind).toBe("teammate_spawn");
    expect(e3.kind).toBe("shutdown_response");
  });
});
