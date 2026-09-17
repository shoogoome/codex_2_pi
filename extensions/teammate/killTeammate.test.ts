import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  killTeammate,
  suspendTeammate,
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
import { createApprovalRequestRegistry } from "./handle.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore } from "./teamTasks/teamTaskStore.js";
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
  return {
    teamStore: ts,
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
}

function buildRunningTask(
  taskId: string,
  teamName = "team1",
): {
  state: InProcessTeammateTaskState;
  abort: ReturnType<typeof vi.fn>;
  sessionAbort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  const ac = new AbortController();
  const abort = vi.fn().mockImplementation(() => ac.abort());
  const sessionAbort = vi.fn().mockResolvedValue(undefined);
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
      abort: sessionAbort,
      dispose,
      prompt: vi.fn(),
      subscribe: vi.fn(),
    } as never,
  };
  return { state, abort, sessionAbort, dispose };
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

  it("running task → status=killed, releases capacity, aborts, and emits terminal", async () => {
    const taskStore = createTaskStore();
    const handle = buildHandle("team1");
    const { state, abort, sessionAbort, dispose } = buildRunningTask("a2");
    const release = vi.fn();
    state.agentResidentLease = {
      released: false,
      release,
    };
    registerTask(state, taskStore);
    await killTeammate(fakePi as never, taskStore, handle, "a2");
    expect(taskStore.getTask("a2")?.status).toBe("killed");
    expect(abort).toHaveBeenCalled();
    expect(sessionAbort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
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

  it("suspend tears down runtime without persisting teammate_terminal", async () => {
    const taskStore = createTaskStore();
    const { state, abort, dispose } = buildRunningTask("a6");
    registerTask(state, taskStore);

    await suspendTeammate(taskStore, "a6");

    expect(taskStore.getTask("a6")).toMatchObject({ status: "killed", notified: true });
    expect(abort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
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

describe("InProcessTeammateTask.describe — \"stuck or busy?\" diagnostics", () => {
  // Regression for a real misdiagnosis: artist-1 was inside `sleep 25 x8`
  // (a 200s bash poll) and could not read leader messages; the leader read
  // silence as "unresponsive" and had it killed. `describe` exists so the
  // caller can tell "inside a long tool call" from "wedged" BEFORE acting.
  function seed(taskId: string, overrides: Partial<InProcessTeammateTaskState>) {
    const store = createTaskStore();
    const { state } = buildRunningTask(taskId);
    registerTask({ ...state, ...overrides } as never, store);
    return store;
  }

  it("reports running state + current tool + held duration", () => {
    const store = seed("t-busy", {
      isIdle: false,
      lastTool: "bash",
      lastToolStartedAt: Date.now() - 200_000,
      turnCount: 4,
      toolCallCount: 37,
    });
    const lines = InProcessTeammateTask.describe!("t-busy", store)!;
    const text = lines.join("\n");
    expect(text).toContain("alpha@team1");
    expect(text).toContain("state: running");
    expect(text).toContain("current tool: bash");
    expect(text).toContain("3m20s");
    expect(text).toContain("turns: 4");
    expect(text).toContain("tool calls: 37");
  });

  it("flags a long-running tool call as NOT a hang (the load-bearing hint)", () => {
    const store = seed("t-longcall", {
      isIdle: false,
      lastTool: "bash",
      lastToolStartedAt: Date.now() - 120_000,
    });
    const text = InProcessTeammateTask.describe!("t-longcall", store)!.join("\n");
    expect(text).toContain("CANNOT read your messages");
  });

  it("does not flag a short tool call", () => {
    const store = seed("t-shortcall", {
      isIdle: false,
      lastTool: "read",
      lastToolStartedAt: Date.now() - 3_000,
    });
    const text = InProcessTeammateTask.describe!("t-shortcall", store)!.join("\n");
    expect(text).not.toContain("CANNOT read your messages");
  });

  it("says idle is NOT the same as finished", () => {
    const store = seed("t-idle", { isIdle: true, turnCount: 2 });
    const text = InProcessTeammateTask.describe!("t-idle", store)!.join("\n");
    expect(text).toContain("state: idle");
    expect(text).toContain("NOT necessarily finished");
  });

  it("reports queued messages (the visible symptom of a blocked teammate)", () => {
    const store = seed("t-queued", {
      isIdle: false,
      lastTool: "bash",
      lastToolStartedAt: Date.now() - 90_000,
      pendingMessages: [
        { from: "leader", body: "please report", ts: 1 },
        { from: "leader", body: "status?", ts: 2 },
      ] as never,
    });
    const text = InProcessTeammateTask.describe!("t-queued", store)!.join("\n");
    expect(text).toContain("queued messages: 2");
    expect(text).toContain("delivered when the current turn ends");
  });

  it("distinguishes an unacknowledged shutdown request (kill is warranted)", () => {
    const store = seed("t-shut1", { shutdownRequested: true, shutdownAcknowledged: false });
    const text = InProcessTeammateTask.describe!("t-shut1", store)!.join("\n");
    expect(text).toContain("NOT yet acknowledged");
    expect(text).toContain("task_kill");
  });

  it("acknowledged shutdown is reported as such", () => {
    const store = seed("t-shut2", { shutdownRequested: true, shutdownAcknowledged: true });
    const text = InProcessTeammateTask.describe!("t-shut2", store)!.join("\n");
    expect(text).toContain("acknowledged");
    expect(text).not.toContain("NOT yet acknowledged");
  });

  it("surfaces lastError", () => {
    const store = seed("t-err", { lastError: "model timeout" });
    const text = InProcessTeammateTask.describe!("t-err", store)!.join("\n");
    expect(text).toContain("last error: model timeout");
  });

  it("returns undefined for an unknown task id", () => {
    const store = createTaskStore();
    expect(InProcessTeammateTask.describe!("nope", store)).toBeUndefined();
  });
});
