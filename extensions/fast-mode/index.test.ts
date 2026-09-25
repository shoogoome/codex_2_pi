import { describe, expect, it, vi } from "vitest";
import fastModeExtension from "./index.js";
import {
  FAST_MODE_STATE_ENTRY,
  applyFastServiceTier,
  isFastCapableModel,
  restoreFastModeState,
} from "./core.js";

const codexModel = {
  provider: "openai-codex",
  id: "gpt-5.6-sol",
  api: "openai-codex-responses",
};

type Handler = (event: any, ctx: any) => any;

function createHarness(options: {
  model?: any;
  oauth?: boolean;
  branch?: unknown[];
  flag?: boolean;
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const model = options.model === undefined ? codexModel : options.model;

  const pi = {
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    getFlag: vi.fn(() => options.flag === true),
  } as any;

  const ctx = {
    model,
    hasUI: true,
    modelRegistry: {
      isUsingOAuth: vi.fn(() => options.oauth !== false),
    },
    sessionManager: {
      getBranch: vi.fn(() => options.branch ?? []),
    },
    ui: {
      notify: vi.fn((message: string, level: string) => notifications.push({ message, level })),
      setStatus: vi.fn((key: string, value: unknown) => statuses.push({ key, value })),
      theme: {
        fg: vi.fn((_color: string, value: string) => value),
        bold: vi.fn((value: string) => value),
      },
    },
  } as any;

  fastModeExtension(pi);
  return { commands, ctx, entries, handlers, notifications, pi, statuses };
}

async function fire(handlers: Map<string, Handler[]>, event: string, payload: any, ctx: any): Promise<any> {
  let result: any;
  for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
  return result;
}

describe("fast mode core", () => {
  it("accepts every OpenAI Codex Responses model without an ID allowlist", () => {
    for (const id of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.4-mini", "future-model"]) {
      expect(isFastCapableModel({ ...codexModel, id } as any)).toBe(true);
    }
    expect(isFastCapableModel({ ...codexModel, provider: "openai" } as any)).toBe(false);
    expect(isFastCapableModel({ ...codexModel, api: "openai-responses" } as any)).toBe(false);
  });

  it("adds priority without mutating the original request", () => {
    const astraModel = { ...codexModel, id: "gpt-6-astra" };
    const payload = { model: "gpt-6-astra", input: [] };
    const result = applyFastServiceTier(payload, {
      enabled: true,
      model: astraModel as any,
      usingOAuth: true,
    });

    expect(result).toEqual({ ...payload, service_tier: "priority" });
    expect(payload).toEqual({ model: "gpt-6-astra", input: [] });
  });

  it("leaves requests unchanged outside the supported OAuth path", () => {
    const payload = { model: "gpt-5.6-sol" };
    expect(applyFastServiceTier(payload, { enabled: false, model: codexModel as any, usingOAuth: true })).toBe(payload);
    expect(applyFastServiceTier(payload, { enabled: true, model: codexModel as any, usingOAuth: false })).toBe(payload);
    expect(applyFastServiceTier(payload, {
      enabled: true,
      model: { ...codexModel, provider: "openai" } as any,
      usingOAuth: true,
    })).toBe(payload);
    expect(applyFastServiceTier("raw", { enabled: true, model: codexModel as any, usingOAuth: true })).toBe("raw");
  });

  it("restores the newest valid session state", () => {
    expect(restoreFastModeState([
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: true } },
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: "bad" } },
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: false } },
    ])).toEqual({ enabled: false });
  });
});

describe("fast mode extension", () => {
  it("registers /fast, the startup flag, and provider/session hooks", () => {
    const harness = createHarness();

    expect(harness.commands.has("fast")).toBe(true);
    expect(harness.pi.registerFlag).toHaveBeenCalledWith("fast", expect.objectContaining({
      type: "boolean",
      default: false,
    }));
    for (const event of [
      "before_provider_request",
      "session_start",
      "session_tree",
      "session_compact",
      "model_select",
      "session_shutdown",
    ]) {
      expect(harness.handlers.has(event)).toBe(true);
    }
  });

  it("toggles Fast on and injects priority into Codex OAuth requests", async () => {
    const harness = createHarness();
    const command = harness.commands.get("fast");

    await command.handler("", harness.ctx);
    expect(harness.entries.at(-1)).toEqual({
      customType: FAST_MODE_STATE_ENTRY,
      data: { enabled: true },
    });
    expect(harness.notifications.at(-1)?.message).toContain("service tier: priority");

    const result = await fire(
      harness.handlers,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.6-sol", input: [] } },
      harness.ctx,
    );
    expect(result).toEqual({ model: "gpt-5.6-sol", input: [], service_tier: "priority" });

    await command.handler("", harness.ctx);
    expect(harness.entries.at(-1)?.data).toEqual({ enabled: false });
    const unchanged = await fire(
      harness.handlers,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.6-sol" } },
      harness.ctx,
    );
    expect(unchanged).toBeUndefined();
  });

  it("does not enable Fast for API-key auth, but allows any Codex model", async () => {
    const apiKeyHarness = createHarness({ oauth: false });
    await apiKeyHarness.commands.get("fast").handler("on", apiKeyHarness.ctx);
    expect(apiKeyHarness.entries).toEqual([]);
    expect(apiKeyHarness.notifications.at(-1)?.message).toContain("OAuth");

    const modelHarness = createHarness({ model: { ...codexModel, id: "gpt-5.4-mini" } });
    await modelHarness.commands.get("fast").handler("on", modelHarness.ctx);
    expect(modelHarness.entries.at(-1)?.data).toEqual({ enabled: true });
    const result = await fire(
      modelHarness.handlers,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.4-mini" } },
      modelHarness.ctx,
    );
    expect(result).toEqual({ model: "gpt-5.4-mini", service_tier: "priority" });
  });

  it("restores Fast from the session branch and from --fast", async () => {
    const restored = createHarness({
      branch: [{ type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: true } }],
    });
    await fire(restored.handlers, "session_start", { type: "session_start", reason: "resume" }, restored.ctx);
    const restoredPayload = await fire(
      restored.handlers,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.6-sol" } },
      restored.ctx,
    );
    expect(restoredPayload).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });

    const flagged = createHarness({ flag: true });
    await fire(flagged.handlers, "session_start", { type: "session_start", reason: "new" }, flagged.ctx);
    const flaggedPayload = await fire(
      flagged.handlers,
      "before_provider_request",
      { type: "before_provider_request", payload: { model: "gpt-5.6-sol" } },
      flagged.ctx,
    );
    expect(flaggedPayload).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" });
  });
});
