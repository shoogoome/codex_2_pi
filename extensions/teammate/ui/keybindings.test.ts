import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerTeammateKeybindings,
  type KeybindingsDeps,
} from "./keybindings.js";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { createViewStateStore } from "./viewState.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
  type TaskStore,
} from "../../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../../tasks/outputPath.js";
import { registerTask } from "../../tasks/framework.js";
import { createTaskStateBase } from "../../tasks/Task.js";
import { createTeamStore } from "../teamStore.js";
import { createMailbox } from "../mailbox.js";
import { createTeamTaskStore } from "../teamTasks/teamTaskStore.js";
import { _resetTeammatePiBindingForTest } from "../killTeammate.js";
import type { TeammateHandle } from "../handle.js";
import type { InProcessTeammateTaskState } from "../types.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function buildHandle(teamName?: string): TeammateHandle {
  const ts = createTeamStore();
  if (teamName) {
    ts.createTeam(teamName, undefined, 1);
  }
  return {
    teamStore: ts,
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
  };
}

interface RunningTaskBuilt {
  state: InProcessTeammateTaskState;
}

function buildRunningTask(
  taskId: string,
  agentName: string,
  teamName: string,
): RunningTaskBuilt {
  const ac = new AbortController();
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
    sessionFile: "/tmp/x.jsonl",
    isIdle: false,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
    abortController: {
      signal: ac.signal,
      abort: vi.fn().mockImplementation(() => ac.abort()),
    } as unknown as AbortController,
    session: {
      abort: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      prompt: vi.fn(),
      subscribe: vi.fn(),
    } as never,
  };
  return { state };
}

interface FakeUI {
  onTerminalInput: ReturnType<typeof vi.fn>;
  handlers: Set<TerminalInputHandler>;
}

function buildFakeUI(): FakeUI {
  const handlers = new Set<TerminalInputHandler>();
  const onTerminalInput = vi.fn((h: TerminalInputHandler) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  });
  return { onTerminalInput, handlers };
}

interface Harness {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  handle: TeammateHandle;
  viewState: ReturnType<typeof createViewStateStore>;
  fakeUI: FakeUI;
  unsub: () => void;
  trigger: (data: string) => ReturnType<TerminalInputHandler>;
}

function makeHarness(opts?: {
  team?: string;
  tasks?: Array<{ id: string; agentName: string; team?: string }>;
}): Harness {
  const team = opts?.team ?? "team1";
  const taskStore = createTaskStore();
  _setDefaultTaskStoreForTest(taskStore);
  const handle = buildHandle(team);
  for (const t of opts?.tasks ?? []) {
    const built = buildRunningTask(t.id, t.agentName, t.team ?? team);
    registerTask(built.state, taskStore);
    handle.teamStore.addMember(t.team ?? team, built.state.identity.agentId);
  }
  const viewState = createViewStateStore();
  const fakeUI = buildFakeUI();
  const fakePi = {
    events: {},
    sendMessage: vi.fn(),
  } as unknown as ExtensionAPI;
  const deps: KeybindingsDeps = {
    pi: fakePi,
    ui: fakeUI as never,
    taskStore,
    handle,
    viewState,
  };
  const unsub = registerTeammateKeybindings(deps);
  const trigger: Harness["trigger"] = (data) => {
    const handler = Array.from(fakeUI.handlers)[0];
    if (!handler) throw new Error("no handler registered");
    return handler(data);
  };
  return { pi: fakePi, taskStore, handle, viewState, fakeUI, unsub, trigger };
}

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetTeammatePiBindingForTest();
});

describe("registerTeammateKeybindings", () => {
  it("registers a handler on ui.onTerminalInput", () => {
    const h = makeHarness();
    expect(h.fakeUI.onTerminalInput).toHaveBeenCalledTimes(1);
    expect(h.fakeUI.handlers.size).toBe(1);
  });

  it("leader + ↑ + has teammates → cycle prev + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    const result = h.trigger("\x1b[A");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
    });
  });

  it("leader + ↑ + no teammates → no-op + not consume", () => {
    const h = makeHarness();
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("leader_with_selection + ↓ → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.selectAgent("alpha@team1");
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
    });
  });

  it("leader_with_selection + Tab → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.selectAgent("alpha@team1");
    const result = h.trigger("\x09");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
    });
  });

  it("leader_with_selection + Enter → enterTeammateView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    const result = h.trigger("\r");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "teammate",
      agentId: "alpha@team1",
    });
  });

  it("leader_with_selection + Esc → reset + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader" });
  });

  it("leader_with_selection + k + selected task exists → kill (status=killed) + reset + consume", async () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    const result = h.trigger("k");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader" });
    // Allow microtasks for the void killTeammate to resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(h.taskStore.getTask("t1")?.status).toBe("killed");
  });

  it("leader_with_selection + k + selected task no longer exists → reset + consume (no throw)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("ghost@team1");
    expect(() => h.trigger("k")).not.toThrow();
    expect(h.viewState.get()).toEqual({ kind: "leader" });
  });

  it("teammate + Enter → exitTeammateView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const result = h.trigger("\r");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "alpha@team1",
    });
  });

  it("teammate + Esc → exitTeammateView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "alpha@team1",
    });
  });

  it("teammate + 'a' → ignore + not consume (passes through to editor)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("a");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("leader + Enter → ignore + not consume (passes through)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("\r");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("leader + k → ignore + not consume (passes through)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("k");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("unsub → handler is no longer registered", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    expect(h.fakeUI.handlers.size).toBe(1);
    h.unsub();
    expect(h.fakeUI.handlers.size).toBe(0);
  });

  it("filters out non-running teammates from cycle pool", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    // Mark beta as completed; cycle should land on alpha only.
    h.taskStore.set((prev) => ({
      ...prev,
      t2: { ...prev.t2!, status: "completed" },
    }));
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "alpha@team1",
    });
  });
});
