import { describe, expect, it, vi } from "vitest";
import todoExtension from "./index.js";

function createPi() {
  const handlers = new Map<string, Function[]>();
  const pi: any = {
    registerTool: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn((event: string, handler: Function) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };
  return { pi, handlers };
}

function createSession(hasUI: boolean) {
  const { pi, handlers } = createPi();
  let branch: unknown[] = [];
  const widgets = new Map<string, { render(width: number): string[] }>();
  const requestRender = vi.fn();
  const theme = {
    fg: (_color: string, text: string) => text,
    strikethrough: (text: string) => text,
  };
  const setWidget = vi.fn((key: string, factory: Function | undefined) => {
    if (factory) widgets.set(key, factory({ requestRender }, theme));
    else widgets.delete(key);
  });
  const ctx: any = { hasUI, ui: { setWidget }, sessionManager: { getBranch: () => branch } };
  pi.appendEntry.mockImplementation((customType: string, data: unknown) => {
    branch.push({ type: "custom", customType, data });
  });
  // Three harnesses deliberately reuse this one imported/cached factory.
  todoExtension(pi);
  const tool = pi.registerTool.mock.calls[0][0];
  return {
    pi, ctx, widgets, setWidget, requestRender,
    setBranch(entries: unknown[]) { branch = entries; },
    async emit(event: string) {
      for (const handler of handlers.get(event) ?? []) await handler({ type: event }, ctx);
    },
    update(step: string) {
      return tool.execute("plan-call", { plan: [{ step, status: "in_progress" }] }, undefined, undefined, ctx);
    },
    render() { return widgets.get("codex-plan-overlay")?.render(100).join("\n") ?? ""; },
  };
}

function branchPlan(step: string) {
  return [{ type: "custom", customType: "codex-plan", data: { plan: [{ step, status: "pending" }], updatedAt: 1 } }];
}

describe("todo extension", () => {
  it("registers update_plan and persists full snapshots", async () => {
    const { pi } = createPi();
    todoExtension(pi);

    expect(pi.registerTool).toHaveBeenCalledTimes(1);
    const tool = pi.registerTool.mock.calls[0][0];
    expect(tool.name).toBe("update_plan");

    const result = await tool.execute(
      "tool-1",
      { plan: [{ step: "Run tests", status: "in_progress" }] },
      undefined,
      undefined,
      { hasUI: false, sessionManager: { getBranch: () => [] } },
    );

    expect(result.content).toEqual([{ type: "text", text: "Plan updated" }]);
    expect(result.details.plan).toEqual([{ step: "Run tests", status: "in_progress" }]);
    expect(pi.appendEntry).toHaveBeenCalledWith("codex-plan", expect.objectContaining({
      plan: [{ step: "Run tests", status: "in_progress" }],
    }));
  });

  it("restores unfinished plans on session_start and shows the overlay", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);

    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      {
        hasUI: true,
        ui: { setWidget },
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: "codex-plan", data: { plan: [{ step: "Continue", status: "pending" }], updatedAt: 1 } },
          ],
        },
      },
    );

    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
  });

  it("does not show stale completed plans on resume", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);

    await handlers.get("session_start")?.[0]?.(
      { type: "session_start", reason: "resume" },
      {
        hasUI: true,
        ui: { setWidget },
        sessionManager: {
          getBranch: () => [
            { type: "custom", customType: "codex-plan", data: { plan: [{ step: "Done", status: "completed" }], updatedAt: 1 } },
          ],
        },
      },
    );

    expect(setWidget).not.toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });
  });

  it("hides held completed overlay on agent_start", async () => {
    const { pi, handlers } = createPi();
    const setWidget = vi.fn();
    todoExtension(pi);
    const tool = pi.registerTool.mock.calls[0][0];
    const ctx: any = { hasUI: true, ui: { setWidget }, sessionManager: { getBranch: () => [] } };

    await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
    await tool.execute("tool-1", { plan: [{ step: "Done", status: "completed" }] }, undefined, undefined, ctx);
    expect(setWidget).toHaveBeenCalledWith("codex-plan-overlay", expect.any(Function), { placement: "aboveEditor" });

    await handlers.get("agent_start")?.[0]?.({ type: "agent_start" }, ctx);
    expect(setWidget).toHaveBeenLastCalledWith("codex-plan-overlay", undefined, { placement: "aboveEditor" });
  });

  it("keeps an already registered root overlay unchanged by two headless workers without session_start", async () => {
    const root = createSession(true);
    const firstWorker = createSession(false);
    const secondWorker = createSession(false);
    await root.update("Root plan");
    const rootWidget = root.widgets.get("codex-plan-overlay")!;
    const rootRegistrations = root.setWidget.mock.calls.length;

    await firstWorker.update("Worker one plan");
    await secondWorker.update("Worker two plan");
    // The actual widget reads its captured getter on every later repaint.
    expect(rootWidget.render(100).join("\n")).toContain("Root plan");
    expect(rootWidget.render(100).join("\n")).not.toContain("Worker");
    expect(root.setWidget).toHaveBeenCalledTimes(rootRegistrations);
    expect(root.requestRender).not.toHaveBeenCalled();
    expect(firstWorker.setWidget).not.toHaveBeenCalled();
    expect(secondWorker.setWidget).not.toHaveBeenCalled();

    firstWorker.ctx.hasUI = true;
    secondWorker.ctx.hasUI = true;
    await firstWorker.update("Worker one visible");
    await secondWorker.update("Worker two visible");
    await root.update("Root next step");
    expect(root.render()).toContain("Root next step");
    expect(firstWorker.render()).toContain("Worker one visible");
    expect(secondWorker.render()).toContain("Worker two visible");
    expect(root.render()).not.toContain("Worker");
    expect(firstWorker.render()).not.toContain("Worker two");
    expect(secondWorker.render()).not.toContain("Worker one");
    expect(root.pi.appendEntry.mock.calls[0][1].plan[0].step).toBe("Root plan");
    expect(firstWorker.pi.appendEntry.mock.calls[0][1].plan[0].step).toBe("Worker one plan");
    expect(secondWorker.pi.appendEntry.mock.calls[0][1].plan[0].step).toBe("Worker two plan");
  });

  it("scopes branch restore, compaction, shutdown and restart to their owning instance", async () => {
    const root = createSession(true);
    const firstWorker = createSession(true);
    const secondWorker = createSession(true);
    await root.update("Root initial");
    await firstWorker.update("First initial");
    await secondWorker.update("Second initial");

    root.setBranch(branchPlan("Root tree branch"));
    await root.emit("session_tree");
    firstWorker.setBranch(branchPlan("First compacted"));
    await firstWorker.emit("session_compact");
    secondWorker.setBranch(branchPlan("Second resumed"));
    await secondWorker.emit("session_start");
    expect(root.render()).toContain("Root tree branch");
    expect(firstWorker.render()).toContain("First compacted");
    expect(secondWorker.render()).toContain("Second resumed");

    const firstWidget = firstWorker.widgets.get("codex-plan-overlay")!;
    await firstWorker.emit("session_shutdown");
    expect(firstWorker.widgets.size).toBe(0);
    expect(firstWidget.render(100)).toEqual([]);
    expect(root.render()).toContain("Root tree branch");
    expect(secondWorker.render()).toContain("Second resumed");

    secondWorker.setBranch([]);
    await secondWorker.emit("session_tree");
    expect(secondWorker.widgets.size).toBe(0);
    expect(root.render()).toContain("Root tree branch");
    firstWorker.setBranch(branchPlan("First restarted"));
    await firstWorker.emit("session_start");
    expect(firstWorker.render()).toContain("First restarted");
    expect(root.render()).toContain("Root tree branch");
  });
});
