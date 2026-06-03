import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTeamDeleteTool } from "./teamDelete.js";
import { attachTeammateHandle, type TeammateHandle } from "../handle.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { createTaskStore, _setDefaultTaskStoreForTest } from "../../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../../tasks/outputPath.js";
import { _clearOutputsForTest } from "../../tasks/diskOutput.js";
import { attachTasksHandle } from "../../tasks/handle.js";
import { _resetTaskTypeRegistryForTest, registerTaskType } from "../../tasks/taskTypeRegistry.js";
import { registerTask, updateTaskState } from "../../tasks/framework.js";
import { createTaskStateBase } from "../../tasks/Task.js";
import type { InProcessTeammateTaskState } from "../types.js";
import type { TaskStore } from "../../tasks/taskStore.js";
import { _bindPi, _resetTeammatePiBindingForTest, InProcessTeammateTask } from "../killTeammate.js";

interface FakePi {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function buildPi(taskStore: TaskStore): FakePi {
  const pi: FakePi = { events: {}, sendMessage: vi.fn() };
  attachTasksHandle(pi as never, {
    store: taskStore,
    registerTaskType,
    getTaskType: () => undefined,
    unregisterTaskType: () => {},
  });
  registerTaskType("in_process_teammate", InProcessTeammateTask);
  return pi;
}

function buildHandle(): TeammateHandle {
  return { teamStore: createTeamStore(), mailbox: createMailbox() };
}

function makeTeammateTask(taskStore: TaskStore, agentName: string, teamName: string): InProcessTeammateTaskState {
  const taskId = `t-${agentName}-${Math.random().toString(36).slice(2, 8)}`;
  const ac = new AbortController();
  const dispose = vi.fn();
  const state: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "in_process_teammate",
      description: `${agentName}@${teamName}`,
      outputFile: `/tmp/${taskId}.out`,
    }),
    type: "in_process_teammate",
    status: "running",
    identity: {
      agentId: `${agentName}@${teamName}`,
      agentName,
      teamName,
      agentType: "general-purpose",
    },
    prompt: "go",
    sessionFile: `/tmp/${taskId}.jsonl`,
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
    abortController: ac,
    session: { abort: vi.fn().mockResolvedValue(undefined), dispose, prompt: vi.fn(), subscribe: vi.fn() } as never,
  };
  registerTask(state, taskStore);
  return state;
}

beforeEach(() => {
  _resetTaskTypeRegistryForTest();
  _resetTaskOutputDirForTest();
  _resetTeammatePiBindingForTest();
});
afterEach(async () => {
  await _clearOutputsForTest();
});

describe("team_delete tool", () => {
  it("rejects empty team_name", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    const pi = buildPi(taskStore);
    attachTeammateHandle(pi as never, handle);
    _bindPi(pi as never);
    const tool = buildTeamDeleteTool(pi as never);
    const result = await tool.execute("c", { team_name: "  " } as never, undefined as never, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it("rejects unknown team", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    const pi = buildPi(taskStore);
    attachTeammateHandle(pi as never, handle);
    _bindPi(pi as never);
    const tool = buildTeamDeleteTool(pi as never);
    const result = await tool.execute("c", { team_name: "ghost" } as never, undefined as never, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/does not exist/);
  });

  it("empty team — emits team_delete + removes from store immediately", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("empty", undefined, 1);
    const pi = buildPi(taskStore);
    attachTeammateHandle(pi as never, handle);
    _bindPi(pi as never);
    const tool = buildTeamDeleteTool(pi as never);
    const result = await tool.execute("c", { team_name: "empty" } as never, undefined as never, undefined, {} as never);
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamStore.getTeam("empty")).toBeUndefined();
    const events = pi.sendMessage.mock.calls.filter(
      ([m]: any[]) => m.customType === "teammate/event"
    );
    const teamDelete = events.find(([m]: any[]) => m.details.kind === "team_delete");
    expect(teamDelete).toBeDefined();
  });

  it("with members — graceful path: members go terminal during shutdown, no force kill", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 1);
    handle.teamStore.addMember("research", "alpha@research");

    // Simulate teammate already running
    const aliceTask = makeTeammateTask(taskStore, "alpha", "research");

    // When mailbox receives shutdown_request, simulate the teammate's loop
    // marking the task terminal "completed" (graceful).
    handle.mailbox.registerReceiver("alpha", (_msg) => {
      // Immediately flip task to terminal completed (simulates fast graceful shutdown).
      updateTaskState<InProcessTeammateTaskState>(aliceTask.id, taskStore, (t) => ({
        ...t,
        status: "completed",
        endTime: Date.now(),
        notified: true,
      }));
      handle.teamStore.removeMember("research", "alpha@research");
    });

    const pi = buildPi(taskStore);
    attachTeammateHandle(pi as never, handle);
    _bindPi(pi as never);
    const tool = buildTeamDeleteTool(pi as never);
    const result = await tool.execute("c", { team_name: "research", timeout_ms: 1000 } as never, undefined as never, undefined, {} as never);

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamStore.getTeam("research")).toBeUndefined();
    const details = result.details as { gracefulCount?: number; forcedCount?: number };
    expect(details.gracefulCount).toBe(1);
    expect(details.forcedCount).toBe(0);
  });

  it("with members — force path: timeout reached → killTeammate invoked", async () => {
    const taskStore = createTaskStore();
    _setDefaultTaskStoreForTest(taskStore);
    const handle = buildHandle();
    handle.teamStore.createTeam("research", undefined, 1);
    handle.teamStore.addMember("research", "alpha@research");

    const _aliceTask = makeTeammateTask(taskStore, "alpha", "research");
    // Receive but DO NOT respond — simulate uncooperative teammate
    handle.mailbox.registerReceiver("alpha", () => {
      // intentional no-op; task stays running
    });

    const pi = buildPi(taskStore);
    attachTeammateHandle(pi as never, handle);
    _bindPi(pi as never);
    const tool = buildTeamDeleteTool(pi as never);
    // Use short timeout to keep the test fast.
    const result = await tool.execute(
      "c",
      { team_name: "research", timeout_ms: 50 } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamStore.getTeam("research")).toBeUndefined();
    // The task should now be killed
    const allTasks = Object.values(taskStore.get());
    const aliceFinal = allTasks.find((t) => "identity" in t && (t as InProcessTeammateTaskState).identity?.agentName === "alpha") as InProcessTeammateTaskState | undefined;
    expect(aliceFinal?.status).toBe("killed");
    const details = result.details as { gracefulCount?: number; forcedCount?: number };
    expect(details.gracefulCount).toBe(0);
    expect(details.forcedCount).toBe(1);
  });
});
