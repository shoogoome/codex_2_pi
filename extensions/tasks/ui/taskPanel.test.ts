import { describe, it, expect } from "vitest";
import { buildTaskPanel } from "./taskPanel.js";
import { createTaskPanelViewStateStore } from "./viewState.js";
import { createTaskStore } from "../taskStore.js";
import { registerTask } from "../framework.js";
import { createTaskStateBase } from "../Task.js";
import type { LocalAgentTaskState } from "../../localagent/types.js";
import type { TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

function fakeTui(): TUI {
  return {
    requestRender: () => {},
  } as unknown as TUI;
}

function fakeTheme(): Theme {
  return {
    fg: (_c: string, t: string) => t,
  } as unknown as Theme;
}

function makeLocalAgent(
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

describe("buildTaskPanel", () => {
  it("returns a component with render() that pulls from stores", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();

    registerTask(makeLocalAgent("a1", "Fix #2"), taskStore);

    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    const lines = component.render(120);

    // Should render at least a header line + the task row
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.includes("Fix #2"))).toBe(true);
    expect(lines.some((l) => l.includes("local_agent"))).toBe(true);
  });

  it("renders [] when no local_agent tasks exist", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    expect(component.render(120)).toEqual([]);
  });

  it("filters out non-local_agent tasks", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();

    // bash task should not appear in the agent panel
    const bashTask = createTaskStateBase({
      id: "babcdef",
      type: "local_bash",
      description: "ls -la",
      outputFile: "/tmp/babcdef.out",
    });
    registerTask({ ...bashTask, status: "running" }, taskStore);

    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    expect(component.render(120)).toEqual([]);
  });

  it("uses viewState focus + selection for highlight", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    registerTask(makeLocalAgent("a1", "Alpha"), taskStore);
    registerTask(makeLocalAgent("a2", "Beta", { startTime: 10 }), taskStore);
    viewState.selectTask("a2");
    viewState.toggleFocus();

    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    const lines = component.render(120);
    const betaRow = lines.find((l) => l.includes("Beta"))!;
    expect(betaRow.startsWith("▶ ")).toBe(true);
  });

  it("dispose is a no-op (idempotent)", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    expect(() => component.dispose?.()).not.toThrow();
  });

  it("filters out completed / killed / failed local_agent tasks (claudecode-style: completed tasks vanish from the panel)", () => {
    // The panel widget owns the live surface. Once a local_agent task
    // flips to a terminal state, its renderResult head is painted into
    // the main stream — keeping the row in the panel as well would
    // double-render the same completion (the bug the user reported).
    // Filter to running only so completed rows immediately disappear
    // from the widget when the spawn promise resolves.
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    registerTask(makeLocalAgent("a1", "Alpha", { status: "running" }), taskStore);
    registerTask(
      makeLocalAgent("a2", "Beta", { status: "completed", startTime: 1 }),
      taskStore,
    );
    registerTask(
      makeLocalAgent("a3", "Gamma", { status: "killed", startTime: 2 }),
      taskStore,
    );
    registerTask(
      makeLocalAgent("a4", "Delta", { status: "failed", startTime: 3 }),
      taskStore,
    );

    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    const lines = component.render(200);
    expect(lines.some((l) => l.includes("Alpha"))).toBe(true);
    expect(lines.some((l) => l.includes("Beta"))).toBe(false);
    expect(lines.some((l) => l.includes("Gamma"))).toBe(false);
    expect(lines.some((l) => l.includes("Delta"))).toBe(false);
  });

  it("when all local_agent tasks are terminal → render returns [] (widget vanishes entirely)", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    registerTask(
      makeLocalAgent("a1", "Done", { status: "completed" }),
      taskStore,
    );
    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    expect(component.render(200)).toEqual([]);
  });

  it("toEntry surfaces last recentToolName as lastTool on the row", () => {
    const taskStore = createTaskStore();
    const viewState = createTaskPanelViewStateStore();
    registerTask(
      makeLocalAgent("a1", "Fix #2", {
        progress: {
          toolCallCount: 2,
          tokenCount: 1234,
          startTime: 0,
          recentToolNames: ["read", "bash"],
        },
      }),
      taskStore,
    );
    const factory = buildTaskPanel({ taskStore, viewState });
    const component = factory(fakeTui(), fakeTheme());
    const lines = component.render(200);
    const row = lines.find((l) => l.includes("Fix #2"))!;
    expect(row).toContain("→ bash");
  });
});
