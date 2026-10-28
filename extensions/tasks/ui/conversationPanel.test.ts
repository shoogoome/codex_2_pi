import { createAgentConversations } from "../agentConversations.js";
import { createTaskStore } from "../taskStore.js";
import { getTaskPanelEntries, buildTaskPanel } from "./taskPanel.js";
import { createTaskPanelViewStateStore } from "./viewState.js";
import { registerTaskPanelKeybindings } from "./taskPanelKeybindings.js";

it("reopens completed records through the focused picker while keeping the compact widget clean", () => {
  const taskStore = createTaskStore();
  const conversations = createAgentConversations();
  const g = conversations.begin({ id: "done", description: "finished", cwd: "/repo", startTime: 1 }, "task");
  conversations.finish("done", g, "completed");
  const viewState = createTaskPanelViewStateStore();
  const panel = buildTaskPanel({ taskStore, conversations, viewState })({} as never, {} as never);
  expect(panel.render(100)).toEqual([]);
  let input!: (key: string) => unknown;
  const details = vi.fn();
  const unsub = registerTaskPanelKeybindings({
    taskStore, conversations, viewState, detailInput: details,
    ui: { onTerminalInput: (fn: (key: string) => unknown) => { input = fn; return () => {}; } } as never,
  });
  expect(getTaskPanelEntries({ taskStore, conversations }, true).map((r) => r.id)).toEqual(["done"]);
  input("\x19"); input("\x1b[B");
  expect(panel.render(100).join("\n")).toContain("最近完成");
  input("\r");
  expect(viewState.get()).toEqual({ kind: "task_output", taskId: "done" });
  for (const key of ["q", "\r", "normal text", "\x07"]) expect(input(key)).toEqual({ consume: true });
  expect(details).toHaveBeenCalledTimes(4);
  expect(viewState.get().kind).toBe("task_output");
  input("\x1b");
  expect(viewState.get().kind).toBe("leader_with_selection");
  unsub();
});
