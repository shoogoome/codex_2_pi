import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  killTeammate,
  InProcessTeammateTask,
  _resetTeammatePiBindingForTest,
} from "./killTeammate.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
} from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { registerTask } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import type { TeammateHandle } from "./handle.js";
import type { InProcessTeammateTaskState } from "./types.js";

const fakePi: { events: Record<string, unknown>; sendMessage: ReturnType<typeof vi.fn> } = {
  events: {},
  sendMessage: vi.fn(),
};

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetTeammatePiBindingForTest();
  fakePi.sendMessage.mockClear();
});

function buildHandle(teamName?: string): TeammateHandle {
  const ts = createTeamStore();
  if (teamName) {
    ts.createTeam(teamName, undefined, 1);
    ts.addMember(teamName, "alpha@" + teamName);
  }
  return { teamStore: ts, mailbox: createMailbox() };
}

function buildRunningTask(
  taskId: string,
  teamName = "team1",
): {
  state: InProcessTeammateTaskState;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const ac = new AbortController();
  const abort = vi.fn().mockImplementation(() => ac.abort());
  const dispose = vi.fn();
  const state: InProcessTeammateTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "in_process_teammate",
      description: `alpha@${teamName}`,
      outputFile: `/tmp/${taskId}.out`,
    }),
    type: "in_process_teammate",
    status: "running",
    identity: {
      agentId: "alpha@" + teamName,
      agentName: "alpha",
      teamName,
      agentType: "general-purpose",
    },
    prompt: "go",
    sessionFile: "/tmp/x.jsonl",
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
    abortController: { signal: ac.signal, abort } as unknown as AbortController,
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      dispose,
      prompt: vi.fn(),
      subscribe: vi.fn(),
    } as never,
  };
  return { state, abort, dispose };
}

describe("killTeammate — basics", () => {
  it("no-op when task missing", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle();
    await killTeammate(fakePi as never, taskStore, handle, "ghost");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("no-op when task already terminal", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state } = buildRunningTask("a1");
    state.status = "completed";
    registerTask(state, taskStore);
    await killTeammate(fakePi as never, taskStore, handle, "a1");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("running task → status=killed, abort+dispose called, teammate_terminal event emitted", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state, abort, dispose } = buildRunningTask("a2");
    registerTask(state, taskStore);
    await killTeammate(fakePi as never, taskStore, handle, "a2");
    expect(taskStore.getTask("a2")?.status).toBe("killed");
    expect(abort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    const events = fakePi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    const terminal = events.find(
      ([m]: unknown[]) => (m as { details: { kind: string } }).details.kind === "teammate_terminal",
    );
    expect(terminal).toBeDefined();
    expect(
      (terminal![0] as { details: { status: string } }).details.status,
    ).toBe("killed");
  });

  it("removes the member from teamStore", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state } = buildRunningTask("a3");
    registerTask(state, taskStore);
    expect(handle.teamStore.getTeam("team1")!.memberAgentIds).toEqual([
      "alpha@team1",
    ]);
    await killTeammate(fakePi as never, taskStore, handle, "a3");
    expect(handle.teamStore.getTeam("team1")!.memberAgentIds).toEqual([]);
  });

  it("repeat kill → second call is no-op", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state } = buildRunningTask("a4");
    registerTask(state, taskStore);
    await killTeammate(fakePi as never, taskStore, handle, "a4");
    fakePi.sendMessage.mockClear();
    await killTeammate(fakePi as never, taskStore, handle, "a4");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("sets endTime + notified=true so loop's onTerminal callback skips re-emit", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state } = buildRunningTask("a5");
    registerTask(state, taskStore);
    await killTeammate(fakePi as never, taskStore, handle, "a5");
    const final = taskStore.getTask("a5");
    expect(final?.notified).toBe(true);
    expect(typeof final?.endTime).toBe("number");
  });
});

describe("InProcessTeammateTask interface", () => {
  it("exposes name + type + kill", () => {
    expect(InProcessTeammateTask.name).toBe("InProcessTeammateTask");
    expect(InProcessTeammateTask.type).toBe("in_process_teammate");
    expect(typeof InProcessTeammateTask.kill).toBe("function");
  });

  it("kill called without _bindPi throws informative error", async () => {
    const taskStore = createTaskStore();
    await expect(
      InProcessTeammateTask.kill("anything", taskStore as never),
    ).rejects.toThrow(/before extension session_start/);
  });
});
