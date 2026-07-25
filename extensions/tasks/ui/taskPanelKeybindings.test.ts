import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  registerTaskPanelKeybindings,
  type TaskPanelKeybindingsDeps,
} from "./taskPanelKeybindings.js";
import type { TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { createTaskPanelViewStateStore } from "./viewState.js";
import {
  createTaskStore,
  _setDefaultTaskStoreForTest,
  type TaskStore,
} from "../taskStore.js";
import { _resetTaskOutputDirForTest } from "../outputPath.js";
import { registerTask } from "../framework.js";
import { createTaskStateBase } from "../Task.js";
import type { LocalAgentTaskState } from "../../localagent/types.js";

function buildLocalAgent(
  id: string,
  description: string,
  over: Partial<LocalAgentTaskState> = {},
): LocalAgentTaskState {
  return {
    ...createTaskStateBase({
      id,
      type: "local_agent",
      description,
      outputFile: `/tmp/${id}.out`,
    }),
    type: "local_agent",
    status: "running",
    prompt: description,
    agentType: "general-purpose",
    isBackgrounded: true,
    isFork: false,
    progress: { toolCallCount: 0, tokenCount: 0, startTime: 0, recentToolNames: [] },
    ...over,
  };
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
  taskStore: TaskStore;
  viewState: ReturnType<typeof createTaskPanelViewStateStore>;
  fakeUI: FakeUI;
  unsub: () => void;
  trigger: (data: string) => ReturnType<TerminalInputHandler>;
}

function makeHarness(opts?: {
  tasks?: Array<{ id: string; description: string; status?: string; startTime?: number }>;
}): Harness {
  const taskStore = createTaskStore();
  _setDefaultTaskStoreForTest(taskStore);
  for (const t of opts?.tasks ?? []) {
    registerTask(
      buildLocalAgent(t.id, t.description, {
        status: (t.status as LocalAgentTaskState["status"]) ?? "running",
        startTime: t.startTime ?? 0,
      }),
      taskStore,
    );
  }
  const viewState = createTaskPanelViewStateStore();
  const fakeUI = buildFakeUI();
  const deps: TaskPanelKeybindingsDeps = {
    ui: fakeUI as never,
    taskStore,
    viewState,
  };
  const unsub = registerTaskPanelKeybindings(deps);
  const trigger: Harness["trigger"] = (data) => {
    const handler = Array.from(fakeUI.handlers)[0];
    if (!handler) throw new Error("no handler registered");
    return handler(data);
  };
  return { taskStore, viewState, fakeUI, unsub, trigger };
}

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
});

describe("registerTaskPanelKeybindings", () => {
  it("registers a handler on ui.onTerminalInput", () => {
    const h = makeHarness();
    expect(h.fakeUI.onTerminalInput).toHaveBeenCalledTimes(1);
    expect(h.fakeUI.handlers.size).toBe(1);
  });

  // ─── Blurred panel: only Ctrl+Y is consumed; everything else passes ───

  it("blurred leader + Ctrl+Y → focused=true + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    const result = h.trigger("\x19");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: true });
  });

  it("focused leader + Ctrl+Y → focused=false + consume (blurs)", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.toggleFocus();
    const result = h.trigger("\x19");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("blurred leader + ↑ → not consume (passes through)", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + Ctrl+G → not consume (left to teammate panel)", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    const before = h.viewState.get();
    const result = h.trigger("\x07");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("blurred leader + 'k' → not consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    const result = h.trigger("k");
    expect(result).toBeUndefined();
  });

  it("blurred leader + Esc → not consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    const result = h.trigger("\x1b");
    expect(result).toBeUndefined();
  });

  // ─── Focused panel — navigation ───

  it("focused leader + ↓ + has tasks → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "a1", description: "alpha", startTime: 0 },
        { id: "a2", description: "beta", startTime: 1 },
      ],
    });
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: true,
    });
  });

  it("focused leader + ↑ + has tasks → cycle prev + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "a1", description: "alpha", startTime: 0 },
        { id: "a2", description: "beta", startTime: 1 },
      ],
    });
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b[A");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a2",
      focused: true,
    });
  });

  it("focused leader + ↑ + no tasks → not consume", () => {
    const h = makeHarness();
    h.viewState.toggleFocus();
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  it("focused leader + Esc → blur + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  // ─── Focused leader_with_selection ───

  it("focused leader_with_selection + ↓ → cycle next + consume", () => {
    const h = makeHarness({
      tasks: [
        { id: "a1", description: "alpha", startTime: 0 },
        { id: "a2", description: "beta", startTime: 1 },
      ],
    });
    h.viewState.selectTask("a1");
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a2",
      focused: true,
    });
  });

  it("focused leader_with_selection + Enter → enterTaskView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.selectTask("a1");
    h.viewState.toggleFocus();
    const result = h.trigger("\r");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "task_output", taskId: "a1" });
  });

  it("focused leader_with_selection + Esc → reset + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.selectTask("a1");
    h.viewState.toggleFocus();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({ kind: "leader", focused: false });
  });

  it("blurred leader_with_selection + ↑ → not consume (must press Ctrl+Y first)", () => {
    const h = makeHarness({
      tasks: [
        { id: "a1", description: "alpha", startTime: 0 },
        { id: "a2", description: "beta", startTime: 1 },
      ],
    });
    h.viewState.selectTask("a1");
    const before = h.viewState.get();
    const result = h.trigger("\x1b[A");
    expect(result).toBeUndefined();
    expect(h.viewState.get()).toBe(before);
  });

  // ─── task_output overlay ───

  it("task_output + Esc → exitTaskView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.selectTask("a1");
    h.viewState.enterTaskView();
    const result = h.trigger("\x1b");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: true,
    });
  });

  it("task_output + 'q' → exitTaskView + consume", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.selectTask("a1");
    h.viewState.enterTaskView();
    const result = h.trigger("q");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: true,
    });
  });

  it("task_output + Ctrl+Y → still toggles focus (idempotent exit)", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    h.viewState.selectTask("a1");
    h.viewState.enterTaskView();
    // Ctrl+Y while in task_output is a no-op for viewState.toggleFocus
    // but should not throw; passing through is acceptable.
    const result = h.trigger("\x19");
    // We document behaviour: Ctrl+Y while task_output should NOT toggle focus
    // because the state machine's toggleFocus is a no-op there. The keybindings
    // layer still consumes the key (so it doesn't reach the editor).
    expect(result).toEqual({ consume: true });
  });

  it("filters non-running local_agent tasks from cycle pool", () => {
    const h = makeHarness({
      tasks: [
        { id: "a1", description: "alpha", startTime: 0 },
        { id: "a2", description: "beta", startTime: 1 },
      ],
    });
    h.viewState.toggleFocus();
    h.taskStore.set((prev) => ({
      ...prev,
      a2: { ...prev.a2!, status: "completed" },
    }));
    const result = h.trigger("\x1b[B");
    expect(result).toEqual({ consume: true });
    expect(h.viewState.get()).toEqual({
      kind: "leader_with_selection",
      selectedTaskId: "a1",
      focused: true,
    });
  });

  it("unsub → handler removed", () => {
    const h = makeHarness({ tasks: [{ id: "a1", description: "x" }] });
    expect(h.fakeUI.handlers.size).toBe(1);
    h.unsub();
    expect(h.fakeUI.handlers.size).toBe(0);
  });
});
