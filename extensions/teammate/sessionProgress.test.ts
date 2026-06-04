// sessionProgress — unit tests for the teammate panel-widget progress
// listener. We don't drive the loop here; instead we hand-build a fake
// AgentSession, snapshot the listener, and emit synthetic SDK events to
// assert the TaskStore mutations.

import { describe, it, expect } from "vitest";

import { subscribeTeammateProgress } from "./sessionProgress.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { registerTask } from "../tasks/framework.js";
import type { InProcessTeammateTaskState } from "./types.js";

interface FakeSession {
  subscribe: (cb: (e: unknown) => void) => () => void;
}

function buildState(taskId: string): InProcessTeammateTaskState {
  return {
    id: taskId,
    type: "in_process_teammate",
    description: "alice@research",
    outputFile: `/tmp/${taskId}.out`,
    outputOffset: 0,
    status: "running",
    notified: false,
    startTime: 1,
    identity: {
      agentId: "alice@research",
      agentName: "alice",
      teamName: "research",
      agentType: "general-purpose",
    },
    prompt: "go",
    sessionFile: "/tmp/s.jsonl",
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
  };
}

interface Ctx {
  taskStore: ReturnType<typeof createTaskStore>;
  taskId: string;
  emit: (e: unknown) => void;
  unsubscribe: () => void;
  unsubscribeCalls: () => number;
}

function setup(): Ctx {
  const taskStore = createTaskStore();
  const taskId = "in_process_teammate-test-1";
  registerTask(buildState(taskId), taskStore);
  let listener: ((e: unknown) => void) | undefined;
  let calls = 0;
  const session: FakeSession = {
    subscribe: (cb) => {
      listener = cb;
      return () => {
        calls += 1;
      };
    },
  };
  const unsubscribe = subscribeTeammateProgress(
    session as unknown as Parameters<typeof subscribeTeammateProgress>[0],
    taskId,
    taskStore,
  );
  return {
    taskStore,
    taskId,
    emit: (e) => listener!(e),
    unsubscribe,
    unsubscribeCalls: () => calls,
  };
}

describe("subscribeTeammateProgress", () => {
  it("accumulates tokenCount from message_end events with assistant usage.totalTokens", () => {
    const { taskStore, taskId, emit } = setup();
    emit({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: 1234 } },
    });
    emit({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: 56 } },
    });
    const t = taskStore.getTask(taskId) as InProcessTeammateTaskState;
    expect(t.tokenCount).toBe(1234 + 56);
  });

  it("ignores message_end without usage and totalTokens=0", () => {
    const { taskStore, taskId, emit } = setup();
    emit({ type: "message_end", message: { role: "user" } });
    emit({
      type: "message_end",
      message: { role: "assistant", usage: { totalTokens: 0 } },
    });
    emit({ type: "message_end" });
    const t = taskStore.getTask(taskId) as InProcessTeammateTaskState;
    expect(t.tokenCount).toBe(0);
  });

  it("bumps toolCallCount + records lastTool / lastToolStartedAt on tool_execution_start", () => {
    const { taskStore, taskId, emit } = setup();
    const before = Date.now();
    emit({
      type: "tool_execution_start",
      toolCallId: "c1",
      toolName: "read",
      args: {},
    });
    emit({
      type: "tool_execution_start",
      toolCallId: "c2",
      toolName: "grep",
      args: {},
    });
    const after = Date.now();
    const t = taskStore.getTask(taskId) as InProcessTeammateTaskState;
    expect(t.toolCallCount).toBe(2);
    expect(t.lastTool).toBe("grep");
    expect(t.lastToolStartedAt).toBeGreaterThanOrEqual(before);
    expect(t.lastToolStartedAt).toBeLessThanOrEqual(after);
  });

  it("ignores tool_execution_start without toolName", () => {
    const { taskStore, taskId, emit } = setup();
    emit({ type: "tool_execution_start", toolCallId: "c1", args: {} });
    const t = taskStore.getTask(taskId) as InProcessTeammateTaskState;
    expect(t.toolCallCount).toBe(0);
    expect(t.lastTool).toBeUndefined();
  });

  it("ignores unrelated SDK events (turn_start, agent_start, message_start)", () => {
    const { taskStore, taskId, emit } = setup();
    emit({ type: "turn_start" });
    emit({ type: "agent_start" });
    emit({ type: "message_start", message: { role: "assistant" } });
    const t = taskStore.getTask(taskId) as InProcessTeammateTaskState;
    expect(t.tokenCount).toBe(0);
    expect(t.toolCallCount).toBe(0);
  });

  it("returned unsubscribe is idempotent (calls SDK unsubscribe at most once)", () => {
    const ctx = setup();
    expect(ctx.unsubscribeCalls()).toBe(0);
    ctx.unsubscribe();
    ctx.unsubscribe();
    ctx.unsubscribe();
    expect(ctx.unsubscribeCalls()).toBe(1);
  });
});
