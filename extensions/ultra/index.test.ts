import { describe, expect, it, vi } from "vitest";
import {
  EXPLICIT_MULTI_AGENT_MODE_PROMPT,
  LEGACY_ULTRA_STATE_ENTRY,
  ULTRA_MODE_PROMPT,
  ULTRA_STATE_ENTRY,
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
    getActiveTools: vi.fn(() => options.activeTools ?? ["read", "task_agent"]),
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

  it("advertises Ultra only for Codex subscription Sol/Terra", () => {
    const { handle } = createHarness();
    expect(handle.isCapable({ provider: "openai-codex", id: "gpt-5.6-sol" })).toBe(true);
    expect(handle.isCapable({ provider: "openai-codex", id: "gpt-5.6-terra" })).toBe(true);
    expect(handle.isCapable({ provider: "openai-codex", id: "gpt-5.6-luna" })).toBe(false);
    expect(handle.isCapable({ provider: "codebuddy", id: "gpt-5.6-sol" })).toBe(false);
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
    expect(result.systemPrompt).toBe(`base\n\n${ULTRA_MODE_PROMPT}`);
    expect(statuses.get("codex-ultra")).toContain("ULTRA");
    expect(notifications[0].msg).toContain("proactive multi-agent delegation enabled");
  });

  it("uses explicit-request-only mode outside Ultra", async () => {
    const { ctx, handlers } = createHarness({ current: "high" });
    const [result] = await fire(handlers, "before_agent_start", { systemPrompt: "base" }, ctx);
    expect(result.systemPrompt).toBe(`base\n\n${EXPLICIT_MULTI_AGENT_MODE_PROMPT}`);
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

  it("returns to explicit mode after effort leaves Ultra", async () => {
    const { ctx, handle, handlers, entries } = createHarness();
    handle.enable(ctx);
    handle.disable(ctx);
    const [result] = await fire(handlers, "before_agent_start", { systemPrompt: "base" }, ctx);
    expect(entries.at(-1)?.data).toEqual({ enabled: false });
    expect(result.systemPrompt).toContain("Do not spawn sub-agents unless");
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

  it("warns when task_agent is installed but inactive", () => {
    const { ctx, handle, notifications } = createHarness({
      activeTools: ["read"],
      allTools: ["read", "task_agent"],
    });
    handle.enable(ctx);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("task_agent is not active");
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

  it("restores the non-Ultra default on shutdown without erasing resumable state", async () => {
    const { ctx, handle, handlers, entries, getCurrent, pi } = createHarness({ current: "high" });
    handle.enable(ctx);
    const lastPersisted = entries.at(-1);
    await fire(handlers, "session_shutdown", { type: "session_shutdown" }, ctx);
    expect(getCurrent()).toBe("high");
    expect(entries.at(-1)).toBe(lastPersisted);
    expect(entries.at(-1)?.data).toEqual({ enabled: true, fallbackLevel: "high" });
    expect(pi.setThinkingLevel).toHaveBeenLastCalledWith("high");
  });

  it("disables on native-effort and unsupported-model changes", async () => {
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
    expect(model.handle.isEnabled()).toBe(false);
    expect(model.entries.at(-1)?.data).toEqual({ enabled: false });
  });
});
