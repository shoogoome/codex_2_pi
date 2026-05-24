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
});
