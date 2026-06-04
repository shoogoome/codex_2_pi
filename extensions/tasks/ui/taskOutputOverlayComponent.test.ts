import { describe, it, expect, vi } from "vitest";
import { buildTaskOutputOverlayComponent } from "./taskOutputOverlayComponent.js";
import type { TaskPanelEntry } from "./taskPanelRender.js";

function makeTask(over: Partial<TaskPanelEntry> = {}): TaskPanelEntry {
  return {
    id: "a1",
    type: "local_agent",
    description: "do work",
    status: "running",
    startTime: 0,
    tokenCount: 0,
    toolCallCount: 0,
    ...over,
  };
}

describe("buildTaskOutputOverlayComponent", () => {
  it("render() pulls latest task + output", () => {
    const getTask = vi.fn(() => makeTask({ description: "Fix #2" }));
    const getOutputContent = vi.fn(() => "hello world");
    const cmp = buildTaskOutputOverlayComponent({
      taskId: "a1",
      getTask,
      getOutputContent,
      defaultHeight: 10,
    });
    const lines = cmp.render(80);
    expect(lines.length).toBe(10);
    expect(lines[0]).toContain("Fix #2");
    expect(lines.find((l) => l.includes("hello world"))).toBeDefined();
    expect(getTask).toHaveBeenCalled();
    expect(getOutputContent).toHaveBeenCalled();
  });

  it("uses (task missing) header when getTask returns undefined", () => {
    const cmp = buildTaskOutputOverlayComponent({
      taskId: "ghost",
      getTask: () => undefined,
      getOutputContent: () => "",
      defaultHeight: 4,
    });
    const lines = cmp.render(80);
    expect(lines[0]).toContain("missing");
  });

  it("uses getHeight callback when provided", () => {
    const cmp = buildTaskOutputOverlayComponent({
      taskId: "a1",
      getTask: () => makeTask(),
      getOutputContent: () => "",
      defaultHeight: 200,
      getHeight: () => 5,
    });
    expect(cmp.render(80).length).toBe(5);
  });

  it("dispose is safe", () => {
    const cmp = buildTaskOutputOverlayComponent({
      taskId: "a1",
      getTask: () => makeTask(),
      getOutputContent: () => "",
    });
    expect(() => cmp.dispose()).not.toThrow();
  });
});
