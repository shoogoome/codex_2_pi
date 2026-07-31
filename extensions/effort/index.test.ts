import { describe, expect, it, vi } from "vitest";
import effortExtension from "./index.js";
import { ULTRA_MODE_PROMPT, ULTRA_STATE_ENTRY } from "./ultra.js";

interface CreatePiOptions {
  current?: string;
  clampMaxTo?: string;
  activeTools?: string[];
}

function createPi(options: CreatePiOptions = {}) {
  let current = options.current ?? "medium";
  const commands = new Map<string, any>();
  const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const pi: any = {
    registerCommand: vi.fn((name: string, def: any) => commands.set(name, def)),
    on: vi.fn((event: string, handler: (event: any, ctx: any) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    }),
    getActiveTools: vi.fn(() => options.activeTools ?? ["read", "task_agent"]),
    getThinkingLevel: vi.fn(() => current),
    setThinkingLevel: vi.fn((level: string) => {
      current = level === "max" && options.clampMaxTo ? options.clampMaxTo : level;
    }),
  };
  return { pi, commands, handlers, entries, getCurrent: () => current };
}

function createCtx(options: {
  model?: { provider: string; id: string };
  branch?: unknown[];
} = {}) {
  const notifications: Array<{ msg: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  const ctx: any = {
    model: options.model ?? { provider: "openai-codex", id: "gpt-5.6-sol" },
    sessionManager: { getBranch: () => options.branch ?? [] },
    ui: {
      notify: vi.fn((msg: string, level?: string) => {
        notifications.push({ msg, level });
      }),
      setStatus: vi.fn((key: string, value: string | undefined) => statuses.set(key, value)),
    },
  };
  return { ctx, notifications, statuses };
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

describe("effort extension", () => {
  it("registers the effort command", () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    expect(commands.has("effort")).toBe(true);
  });

  it("shows current level when called without args", async () => {
    const { pi, commands } = createPi({ current: "high" });
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("", ctx);
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].msg).toContain("high");
  });

  it("sets a valid level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("high", ctx);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("high");
    expect(notifications[0].msg).toContain("high");
  });

  it("sets pi's native max level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("max", ctx);
    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(notifications[0].msg).toContain("Effort set to max");
  });

  it("maps ultra to native max and enables the Codex proactive orchestration prompt", async () => {
    const { pi, commands, handlers, entries } = createPi();
    effortExtension(pi);
    const { ctx, notifications, statuses } = createCtx();

    await commands.get("effort").handler("ultra", ctx);
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: "base prompt" },
      ctx,
    );

    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(entries.at(-1)).toEqual({
      type: "custom",
      customType: ULTRA_STATE_ENTRY,
      data: { enabled: true },
    });
    expect(result.systemPrompt).toBe(`base prompt\n\n${ULTRA_MODE_PROMPT}`);
    expect(statuses.get("effort-ultra")).toBe("effort:ultra");
    expect(notifications[0].msg).toContain("proactive task delegation enabled");
  });

  it("restores ultra from the active session branch", async () => {
    const { pi, commands, handlers } = createPi({ current: "max" });
    effortExtension(pi);
    const { ctx, notifications } = createCtx({
      branch: [
        { type: "custom", customType: ULTRA_STATE_ENTRY, data: { enabled: false } },
        { type: "custom", customType: ULTRA_STATE_ENTRY, data: { enabled: true } },
      ],
    });

    await fire(handlers, "session_start", { type: "session_start", reason: "resume" }, ctx);
    await commands.get("effort").handler("", ctx);
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: "base" },
      ctx,
    );

    expect(notifications[0].msg).toContain("ultra (native: max");
    expect(result.systemPrompt).toContain("Proactive multi-agent delegation is active");
  });

  it("leaving ultra persists disabled state and removes orchestration on the next turn", async () => {
    const { pi, commands, handlers, entries } = createPi();
    effortExtension(pi);
    const { ctx } = createCtx();

    await commands.get("effort").handler("ultra", ctx);
    await commands.get("effort").handler("high", ctx);
    const [result] = await fire(
      handlers,
      "before_agent_start",
      { systemPrompt: "base" },
      ctx,
    );

    expect(entries.at(-1)?.data).toEqual({ enabled: false });
    expect(pi.getThinkingLevel()).toBe("high");
    expect(result).toBeUndefined();
  });

  it("disables ultra when native thinking changes away from max", async () => {
    const { pi, commands, handlers, entries } = createPi();
    effortExtension(pi);
    const { ctx } = createCtx();

    await commands.get("effort").handler("ultra", ctx);
    await fire(
      handlers,
      "thinking_level_select",
      { type: "thinking_level_select", level: "high", previousLevel: "max" },
      ctx,
    );

    expect(entries.at(-1)?.data).toEqual({ enabled: false });
  });

  it("supports the other Codex Ultra model, gpt-5.6-terra", async () => {
    const { pi, commands, entries } = createPi();
    effortExtension(pi);
    const { ctx } = createCtx({
      model: { provider: "openai-codex", id: "gpt-5.6-terra" },
    });

    await commands.get("effort").handler("ultra", ctx);

    expect(pi.setThinkingLevel).toHaveBeenCalledWith("max");
    expect(entries.at(-1)?.data).toEqual({ enabled: true });
  });

  it("rejects ultra outside the Codex-supported model family", async () => {
    const { pi, commands, entries } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx({
      model: { provider: "openai-codex", id: "gpt-5.6-luna" },
    });

    await commands.get("effort").handler("ultra", ctx);

    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("gpt-5.6-sol");
  });

  it("disables ultra when switching to an unsupported model", async () => {
    const { pi, commands, handlers, entries } = createPi();
    effortExtension(pi);
    const { ctx } = createCtx();

    await commands.get("effort").handler("ultra", ctx);
    await fire(
      handlers,
      "model_select",
      {
        type: "model_select",
        model: { provider: "openai-codex", id: "gpt-5.6-luna" },
        previousModel: ctx.model,
        source: "set",
      },
      { ...ctx, model: { provider: "openai-codex", id: "gpt-5.6-luna" } },
    );

    expect(entries.at(-1)?.data).toEqual({ enabled: false });
  });

  it("rejects ultra when the provider configuration cannot expose native max", async () => {
    const { pi, commands, entries, getCurrent } = createPi({
      current: "high",
      clampMaxTo: "xhigh",
    });
    effortExtension(pi);
    const { ctx, notifications } = createCtx({
      model: { provider: "codebuddy", id: "gpt-5.6-sol" },
    });

    await commands.get("effort").handler("ultra", ctx);

    expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(1, "max");
    expect(pi.setThinkingLevel).toHaveBeenNthCalledWith(2, "high");
    expect(getCurrent()).toBe("high");
    expect(entries).toHaveLength(0);
    expect(notifications[0].msg).toContain("does not expose native max effort");
  });

  it("warns when ultra is enabled without task_agent", async () => {
    const { pi, commands } = createPi({ activeTools: ["read"] });
    effortExtension(pi);
    const { ctx, notifications } = createCtx();

    await commands.get("effort").handler("ultra", ctx);

    expect(notifications[0].level).toBe("warning");
    expect(notifications[0].msg).toContain("task_agent is not active");
  });

  it("rejects an invalid level", async () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    const { ctx, notifications } = createCtx();
    await commands.get("effort").handler("turbo", ctx);
    expect(pi.setThinkingLevel).not.toHaveBeenCalled();
    expect(notifications[0].level).toBe("warning");
  });

  it("provides argument completions including ultra", () => {
    const { pi, commands } = createPi();
    effortExtension(pi);
    expect(commands.get("effort").getArgumentCompletions("hi")).toEqual([
      { value: "high", label: "high" },
    ]);
    expect(commands.get("effort").getArgumentCompletions("ma")).toEqual([
      { value: "max", label: "max" },
    ]);
    expect(commands.get("effort").getArgumentCompletions("ul")).toEqual([
      { value: "ultra", label: "ultra" },
    ]);
  });
});
