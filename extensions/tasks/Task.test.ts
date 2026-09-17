import { describe, expect, it, vi } from "vitest";
import {
  createTaskStateBase,
  generateTaskId,
  isTerminalTaskStatus,
  type TaskStatus,
  type TaskType,
} from "./Task.js";

describe("isTerminalTaskStatus", () => {
  it("treats completed/failed/killed as terminal", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true);
    expect(isTerminalTaskStatus("failed")).toBe(true);
    expect(isTerminalTaskStatus("killed")).toBe(true);
  });

  it("treats pending/running as non-terminal", () => {
    expect(isTerminalTaskStatus("pending")).toBe(false);
    expect(isTerminalTaskStatus("running")).toBe(false);
  });
});

describe("generateTaskId", () => {
  const expectedPrefix: Record<TaskType, string> = {
    local_bash: "b",
    local_agent: "a",
    remote_agent: "r",
    in_process_teammate: "t",
    local_workflow: "w",
    monitor_mcp: "m",
    dream: "d",
    async_shell: "b", // reuses the bash prefix — it IS a bash job, just backgrounded
  };

  it("uses the expected prefix per task type", () => {
    for (const [type, prefix] of Object.entries(expectedPrefix) as [TaskType, string][]) {
      const id = generateTaskId(type);
      expect(id.startsWith(prefix)).toBe(true);
    }
  });

  it("produces ids of length 9 (1 prefix + 8 hex)", () => {
    expect(generateTaskId("local_bash")).toHaveLength(9);
  });

  it("uses the lowercase + digit alphabet", () => {
    const id = generateTaskId("local_agent");
    expect(id).toMatch(/^[a-z][0-9a-z]{8}$/);
  });

  it("does not collide across many sequential generations", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateTaskId("local_bash"));
    }
    expect(seen.size).toBe(1000);
  });
});

describe("createTaskStateBase", () => {
  it("populates defaults — pending status, outputOffset 0, notified false", () => {
    const now = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    try {
      const state = createTaskStateBase({
        id: "babcdefgh",
        type: "local_bash",
        description: "echo hi",
        outputFile: "/tmp/babcdefgh.output",
      });

      expect(state).toStrictEqual<typeof state>({
        id: "babcdefgh",
        type: "local_bash",
        status: "pending" satisfies TaskStatus,
        description: "echo hi",
        toolUseId: undefined,
        startTime: now,
        outputFile: "/tmp/babcdefgh.output",
        outputOffset: 0,
        notified: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains optional toolUseId when provided", () => {
    const state = createTaskStateBase({
      id: "babcdefgh",
      type: "local_bash",
      description: "echo hi",
      outputFile: "/tmp/babcdefgh.output",
      toolUseId: "tool_use_123",
    });
    expect(state.toolUseId).toBe("tool_use_123");
  });
});
