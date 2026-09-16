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
import { createApprovalRequestRegistry, type TeammateHandle } from "../handle.js";
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
    approvalRequests: createApprovalRequestRegistry(),
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

describe("registerTeammateKeybindings (focus-aware)", () => {
  it("registers a handler on ui.onTerminalInput", () => {
    const h = makeHarness();
    expect(h.fakeUI.onTerminalInput).toHaveBeenCalledTimes(1);
    expect(h.fakeUI.handlers.size).toBe(1);
  });

  // ─── Blurred panel: only Ctrl+G is consumed; everything else passes ───

  it("blurred leader + ↑ → ignore + not consume (passes through)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + Tab → ignore + not consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("\x09");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + Enter → ignore + not consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("\r");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + Esc → ignore + not consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("\x1b");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + k → ignore + not consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("k");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + 'a' (printable) → ignore + not consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const before = h.viewState.get();
    const result = h.trigger("a");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  // ─── Ctrl+G — universal toggle ───

  it("blurred leader + Ctrl+G → focused=true + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    const result = h.trigger("\x07");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: true });
  });

  it("focused leader + Ctrl+G → focused=false + consume (blurs)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.toggleFocus();
    const result = h.trigger("\x07");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("teammate view + Ctrl+G → ignore + not consume (editor owns it)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("\x07");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  // ─── Focused panel — navigation ───

  it("focused leader + ↑ + has teammates → cycle prev + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b[A");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
      focused: true,
    });
  });

  it("focused leader + ↑ + no teammates → no-op + not consume", () => {
    const h = makeHarness();
    h.viewState.toggleFocus();
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("focused leader + Esc → blur + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("focused leader_with_selection + ↓ → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
      focused: true,
    });
  });

  it("focused leader_with_selection + Tab → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.toggleFocus();
    const result = h.trigger("\x09");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "beta@team1",
      focused: true,
    });
  });

  it("focused leader_with_selection + Enter → enterTeammateView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.toggleFocus();
    const result = h.trigger("\r");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "teammate",
      agentId: "alpha@team1",
    });
  });

  it("focused leader_with_selection + Esc → reset + consume", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("focused leader_with_selection + k + selected task exists → kill + reset + consume", async () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.toggleFocus();
    const result = h.trigger("k");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.taskStore.getTask("t1")?.status).toBe("killed");
  });

  it("focused leader_with_selection + k + selected task missing → reset + consume (no throw)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("ghost@team1");
    h.viewState.toggleFocus();
    expect(() => h.trigger("k")).not.toThrow();
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("blurred leader_with_selection + ↑ → ignore + not consume (must press Ctrl+G first)", () => {
    const h = makeHarness({
      tasks: [
        { id: "t1", agentName: "alpha" },
        { id: "t2", agentName: "beta" },
      ],
    });
    h.viewState.selectAgent("alpha@team1");
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  // ─── Teammate view — ALL keys pass through to the swapped editor ───

  it("teammate + Enter → pass through (editor owns submit/exit)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("\r");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("teammate + Esc → pass through (editor owns submit/exit)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("\x1b");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("teammate + 'a' → pass through (editor owns input)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("a");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("teammate + Tab → pass through (editor owns input)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("\x09");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("teammate + ↑ → pass through (editor owns input)", () => {
    const h = makeHarness({ tasks: [{ id: "t1", agentName: "alpha" }] });
    h.viewState.selectAgent("alpha@team1");
    h.viewState.enterTeammateView();
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  // ─── Misc ───

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
    h.viewState.toggleFocus();
    h.taskStore.set((prev) => ({
      ...prev,
      t2: { ...prev.t2!, status: "completed" },
    }));
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedAgentId: "alpha@team1",
      focused: true,
    });
  });
});
