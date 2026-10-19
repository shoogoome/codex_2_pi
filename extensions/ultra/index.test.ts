import { describe, expect, it, vi } from "vitest";
import {
  EXPLICIT_MULTI_AGENT_MODE_PROMPT,
  LEGACY_ULTRA_STATE_ENTRY,
  ULTRA_MODE_PROMPT,
  ULTRA_STATE_ENTRY,
  ULTRA_WORKFLOW_PROMPT,
} from "./core.js";
import { getUltraHandle } from "./handle.js";
import ultraExtension from "./index.js";

type Model = { provider: string; id: string };

interface HarnessOptions {
  current?: string;
  clampMaxTo?: string;
  model?: Model;
  branch?: unknown[];
  activeTools?: string[];
  allTools?: string[];
}

function createHarness(options: HarnessOptions = {}) {
  let current = options.current ?? "medium";
  let model = options.model ?? { provider: "openai-codex", id: "gpt-5.6-sol" };
  let activeTools = [...(options.activeTools ?? ["read", "task_agent"])];
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const notifications: Array<{ msg: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const pi: any = {
    events: {},
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    getThinkingLevel: vi.fn(() => current),
    setThinkingLevel: vi.fn((level: string) => {
      current = level === "max" && options.clampMaxTo ? options.clampMaxTo : level;
    }),
    getActiveTools: vi.fn(() => [...activeTools]),
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = [...tools];
    }),
    getAllTools: vi.fn(() => (options.allTools ?? ["read", "task_agent"]).map((name) => ({ name }))),
  };
  const ui: any = {
    notify: vi.fn((msg: string, level?: string) => notifications.push({ msg, level })),
    setStatus: vi.fn((key: string, value: string | undefined) => statuses.set(key, value)),
    setWidget: vi.fn(),
    theme: {
      fg: vi.fn((_color: string, text: string) => text),
      bold: vi.fn((text: string) => text),
    },
  };
  const ctx: any = {
    hasUI: true,
    get model() {
      return model;
    },
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui,
  };
  ultraExtension(pi);
  const handle = getUltraHandle(pi);
  if (!handle) throw new Error("Ultra handle was not attached");

  return {
    pi,
    ctx,
    handle,
    handlers,
    entries,
    notifications,
    statuses,
    getCurrent: () => current,
    getActiveTools: () => [...activeTools],
    setActiveTools: (tools: string[]) => {
      activeTools = [...tools];
    },
    setModel: (next: Model) => {
      model = next;
    },
  };
}

async function fire(
  handlers: Map<string, Array<(event: any, ctx: any) => any>>,
  event: string,
  payload: any,
  ctx: any,
): Promise<any[]> {
  const results = [];
  for (const handler of handlers.get(event) ?? []) results.push(await handler(payload, ctx));
  return results;
}

describe("Ultra controller registration", () => {
  it("attaches a shared handle and owns request/state lifecycle events", () => {
    const { handle, handlers } = createHarness();
    expect(handle.isEnabled()).toBe(false);
    for (const event of [
      "before_agent_start",
      "thinking_level_select",
      "model_select",
      "session_start",
      "session_tree",
      "session_compact",
      "session_shutdown",
    ]) {
      expect(handlers.has(event)).toBe(true);
    }
  });

  it("allows Ultra for any active model", () => {
    const { handle } = createHarness();
    expect(handle.isCapable({ provider: "openai-codex", id: "gpt-5.6-sol" })).toBe(true);
    expect(handle.isCapable({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe(true);
    expect(handle.isCapable({ provider: "codebuddy", id: "any-model" })).toBe(true);
    expect(handle.isCapable(undefined)).toBe(false);
  });
});

describe("Ultra request semantics", () => {
  it("maps conversation Ultra to native max and proactive multi-agent mode", async () => {
    const { pi, ctx, handle, handlers, entries, statuses, notifications } = createHarness();
    expect(handle.enable(ctx)).toBe(true);
    const [result] = await fire(handlers, "before_agent_start", { systemPrompt: "base" }, ctx);

    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(entries.at(-1)).toEqual({
      type: "custom",
      customType: ULTRA_STATE_ENTRY,
      data: { enabled: true, fallbackLevel: "medium" },
    });
    expect(result.systemPrompt).toBe(
      `base\n\n${ULTRA_MODE_PROMPT}\n\n${ULTRA_WORKFLOW_PROMPT}`,
    );
    expect(statuses.get("codex-ultra")).toContain("workflow active");
    expect(notifications[0].msg).toContain("multi-agent workflow active");
  });

  it("uses explicit-request-only mode outside Ultra", async () => {
    const { ctx, handlers } = createHarness({ current: "high" });
    const [result] = await fire(handlers, "before_agent_start", { systemPrompt: "base" }, ctx);
    expect(result.systemPrompt).toBe(`base\n\n${EXPLICIT_MULTI_AGENT_MODE_PROMPT}`);
  });

  it("clears an Ultra workflow block and keeps explicit mode on other models", async () => {
    const { ctx, handlers } = createHarness({
      model: { provider: "codebuddy", id: "any-model" },
    });
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: `base\n\n${ULTRA_WORKFLOW_PROMPT}` },
      ctx,
    );

    expect(result.systemPrompt).toBe(`base\n\n${EXPLICIT_MULTI_AGENT_MODE_PROMPT}`);
  });

  it("keeps the combined mode and workflow blocks idempotent", async () => {
    const { ctx, handle, handlers } = createHarness();
    handle.enable(ctx);
    const [first] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: "base" },
      ctx,
    );
    const [second] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: first.systemPrompt },
      ctx,
    );

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.systemPrompt.match(/<multi_agent_mode>/g)).toHaveLength(1);
    expect(second.systemPrompt.match(/<ultra_multi_agent_workflow>/g)).toHaveLength(1);
  });

  it("replaces a previous mode block instead of accumulating conflicts", async () => {
    const { ctx, handle, handlers } = createHarness();
    handle.enable(ctx);
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: `base\n\n${EXPLICIT_MULTI_AGENT_MODE_PROMPT}` },
      ctx,
    );
    expect(result.systemPrompt.match(/<multi_agent_mode>/g)).toHaveLength(1);
    expect(result.systemPrompt).toContain("Proactive multi-agent delegation is active");
    expect(result.systemPrompt).not.toContain("Do not spawn sub-agents unless");
  });

  it("returns to explicit mode and clears the workflow block after effort leaves Ultra", async () => {
    const { ctx, handle, handlers, entries } = createHarness();
    handle.enable(ctx);
    const [ultraResult] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: "base" },
      ctx,
    );
    handle.disable(ctx);
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: ultraResult.systemPrompt },
      ctx,
    );
    expect(entries.at(-1)?.data).toEqual({ enabled: false });
    expect(result.systemPrompt).toContain("Do not spawn sub-agents unless");
    expect(result.systemPrompt).not.toContain("<ultra_multi_agent_workflow>");
  });

  it("rejects activation when native max is unavailable", () => {
    const { pi, ctx, handle, entries, notifications, getCurrent } = createHarness({
      current: "high",
      clampMaxTo: "xhigh",
    });
    expect(handle.enable(ctx)).toBe(false);
    expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(1, "max");
    expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(2, "high");
    expect(getCurrent()).toBe("high");
    expect(entries).toHaveLength(0);
    expect(notifications[0].msg).toContain("does not expose native max");
  });

  it("auto-enables an installed inactive task_agent", () => {
    const { pi, ctx, handle, notifications, statuses, getActiveTools } = createHarness({
      activeTools: ["read"],
      allTools: ["read", "task_agent"],
    });
    handle.enable(ctx);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "task_agent"]);
    expect(getActiveTools()).toEqual(["read", "task_agent"]);
    expect(notifications[0]).toEqual(expect.objectContaining({ level: "info" }));
    expect(notifications[0].msg).toContain("workflow active");
    expect(notifications[0].msg).toContain("task_agent auto-enabled");
    expect(statuses.get("codex-ultra")).toContain("workflow active");
  });

  it("reports why the workflow is paused when task_agent is unavailable", () => {
    const { pi, ctx, handle, notifications, statuses } = createHarness({
      activeTools: ["read"],
      allTools: ["read"],
    });
    handle.enable(ctx);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("workflow paused: task_agent is not installed");
    expect(statuses.get("codex-ultra")).toContain("workflow paused (task_agent unavailable)");
  });

  it("keeps the plan-mode read-only gate and reports the workflow as paused", async () => {
    const { pi, ctx, handle, handlers, notifications, statuses, getActiveTools } = createHarness({
      activeTools: ["read", "exit_plan_mode"],
      allTools: ["read", "exit_plan_mode", "task_agent"],
    });
    handle.enable(ctx);
    const [result] = await fire(handlers, "before_agent_start", { systemPrompt: "base" }, ctx);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(getActiveTools()).toEqual(["read", "exit_plan_mode"]);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("workflow paused: plan mode read-only gate");
    expect(statuses.get("codex-ultra")).toContain("workflow paused (plan mode)");
    expect(result.systemPrompt).toContain(ULTRA_MODE_PROMPT);
    expect(result.systemPrompt).not.toContain("<ultra_multi_agent_workflow>");
  });

  it("temporarily removes Ultra's own task_agent activation inside plan mode", async () => {
    const harness = createHarness({
      activeTools: ["read"],
      allTools: ["read", "task_agent", "exit_plan_mode"],
    });
    harness.handle.enable(harness.ctx);
    harness.setActiveTools(["read", "task_agent", "exit_plan_mode"]);
    harness.pi.setActiveTools.mockClear();
    const [paused] = await fire(
      harness.handlers,
      "before_agent_start",
      { systemPrompt: "base" },
      harness.ctx,
    );

    expect(harness.pi.setActiveTools).toHaveBeenCalledWith(["read", "exit_plan_mode"]);
    expect(harness.getActiveTools()).toEqual(["read", "exit_plan_mode"]);
    expect(paused.systemPrompt).not.toContain("<ultra_multi_agent_workflow>");
  });

  it("removes only the task_agent activation owned by Ultra on disable", () => {
    const added = createHarness({
      activeTools: ["read"],
      allTools: ["read", "grep", "task_agent"],
    });
    added.handle.enable(added.ctx);
    added.setActiveTools(["read", "grep", "task_agent"]);
    added.pi.setActiveTools.mockClear();
    added.handle.disable(added.ctx);
    expect(added.pi.setActiveTools).toHaveBeenCalledWith(["read", "grep"]);

    const preselected = createHarness({ activeTools: ["read", "task_agent"] });
    preselected.handle.enable(preselected.ctx);
    preselected.pi.setActiveTools.mockClear();
    preselected.handle.disable(preselected.ctx);
    expect(preselected.pi.setActiveTools).not.toHaveBeenCalled();
    expect(preselected.getActiveTools()).toEqual(["read", "task_agent"]);
  });
});

describe("Ultra session lifecycle", () => {
  it("restores new and legacy branch entries by re-applying native max", async () => {
    for (const customType of [ULTRA_STATE_ENTRY, LEGACY_ULTRA_STATE_ENTRY]) {
      const harness = createHarness({
        current: "medium",
        branch: [
          { type: "custom", customType, data: { enabled: true, fallbackLevel: "high" } },
        ],
      });
      await fire(
        harness.handlers,
        "session_start",
        { type: "session_start", reason: "resume" },
        harness.ctx,
      );
      expect(harness.handle.isEnabled()).toBe(true);
      expect(harness.getCurrent()).toBe("max");
    }
  });

  it("auto-enables task_agent when restoring an Ultra session", async () => {
    const harness = createHarness({
      current: "medium",
      activeTools: ["read"],
      allTools: ["read", "task_agent"],
      branch: [
        {
          type: "custom",
          customType: ULTRA_STATE_ENTRY,
          data: { enabled: true, fallbackLevel: "high" },
        },
      ],
    });
    await fire(
      harness.handlers,
      "session_start",
      { type: "session_start", reason: "resume" },
      harness.ctx,
    );

    expect(harness.pi.setActiveTools).toHaveBeenCalledWith(["read", "task_agent"]);
    expect(harness.getActiveTools()).toEqual(["read", "task_agent"]);
    expect(harness.statuses.get("codex-ultra")).toContain("workflow active");
    expect(harness.notifications[0].msg).toContain("Ultra restored");
    expect(harness.notifications[0].msg).toContain("task_agent auto-enabled");
  });

  it("does not auto-enable task_agent when Ultra is restored in plan mode", async () => {
    const harness = createHarness({
      activeTools: ["read", "exit_plan_mode"],
      allTools: ["read", "exit_plan_mode", "task_agent"],
      branch: [
        {
          type: "custom",
          customType: ULTRA_STATE_ENTRY,
          data: { enabled: true, fallbackLevel: "medium" },
        },
      ],
    });
    await fire(
      harness.handlers,
      "session_start",
      { type: "session_start", reason: "resume" },
      harness.ctx,
    );

    expect(harness.pi.setActiveTools).not.toHaveBeenCalled();
    expect(harness.getActiveTools()).toEqual(["read", "exit_plan_mode"]);
    expect(harness.statuses.get("codex-ultra")).toContain("workflow paused (plan mode)");
    expect(harness.notifications[0].msg).toContain("workflow paused: plan mode read-only gate");
  });

  it("restores the non-Ultra default on shutdown without erasing resumable state", async () => {
    const { ctx, handle, handlers, entries, getCurrent, pi } = createHarness({ current: "high" });
    handle.enable(ctx);
    const lastPersisted = entries.at(-1);
    await fire(handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
    expect(getCurrent()).toBe("high");
    expect(entries.at(-1)).toBe(lastPersisted);
    expect(entries.at(-1)?.data).toEqual({ enabled: true, fallbackLevel: "high" });
    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("high");
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("removes only Ultra's task_agent activation on shutdown", async () => {
    const harness = createHarness({
      activeTools: ["read"],
      allTools: ["read", "grep", "task_agent"],
    });
    harness.handle.enable(harness.ctx);
    harness.setActiveTools(["read", "grep", "task_agent"]);
    harness.pi.setActiveTools.mockClear();
    await fire(
      harness.handlers,
      "session_shutdown",
      { type: "session_shutdown" },
      harness.ctx,
    );

    expect(harness.pi.setActiveTools).toHaveBeenCalledWith(["read", "grep"]);
    expect(harness.getActiveTools()).toEqual(["read", "grep"]);
  });

  it("disables on native-effort changes and survives model changes", async () => {
    const thinking = createHarness();
    thinking.handle.enable(thinking.ctx);
    await fire(
      thinking.handlers,
      "thinking_level_select",
      { type: "thinking_level_select", level: "high", previousLevel: "max" },
      thinking.ctx,
    );
    expect(thinking.handle.isEnabled()).toBe(false);
    expect(thinking.entries.at(-1)?.data).toEqual({ enabled: false });

    const model = createHarness();
    model.handle.enable(model.ctx);
    model.setModel({ provider: "openai-codex", id: "gpt-5.6-luna" });
    await fire(
      model.handlers,
      "model_select",
      {
        type: "model_select",
        model: { provider: "openai-codex", id: "gpt-5.6-luna" },
        previousModel: { provider: "openai-codex", id: "gpt-5.6-sol" },
        source: "set",
      },
      model.ctx,
    );
    expect(model.handle.isEnabled()).toBe(true);
    expect(model.entries).toHaveLength(1);
  });
});
