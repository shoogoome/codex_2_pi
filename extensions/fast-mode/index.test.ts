import { EventEmitter } from "node:events";
import { getFastModeReader } from "./handle.js";
import { registerForkWorker } from "../localagent/workerIdentity.js";
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
  ultraFlag?: boolean;
  defaultMode?: "off" | "fast" | "ultrafast";
} = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  const statuses: Array<{ key: string; value: unknown }> = [];
  const model = options.model === undefined ? codexModel : options.model;

  const pi = {
    events: new EventEmitter(),
    registerFlag: vi.fn(),
    registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => entries.push({ customType, data })),
    getFlag: vi.fn((name: string) => name === "ultrafast" ? options.ultraFlag === true : options.flag === true),
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

  fastModeExtension(pi, {
    loadSettings: () => ({ mode: options.defaultMode ?? "off", warnings: [] }),
  });
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

  it.each(["priority", "ultrafast"] as const)("serializes %s before large input for HTTP and WebSocket", (tier) => {
    const options = { enabled: true, model: codexModel, usingOAuth: true, tier };
    for (const previousTier of [undefined, tier, "default"]) {
      const payload = Object.freeze({
        input: [{ role: "user", content: "x".repeat(2 * 1024 * 1024) }],
        tools: [{ type: "function", name: "test" }],
        model: codexModel.id,
        stream: true,
        ...(previousTier === undefined ? {} : { service_tier: previousTier }),
      });
      const result = applyFastServiceTier(payload, options) as Record<string, unknown>;
      expect(Object.keys(result).slice(0, 3)).toEqual(["model", "stream", "service_tier"]);
      expect(result).toEqual({ ...payload, service_tier: tier });
      expect(result.input).toBe(payload.input);
      expect(payload.service_tier).toBe(previousTier);
      for (const wire of [JSON.stringify(result), JSON.stringify({ type: "response.create", ...result })]) {
        expect(wire.indexOf('"service_tier"')).toBeLessThan(wire.indexOf('"input"'));
        expect(wire.indexOf('"service_tier"')).toBeLessThan(100);
        expect(JSON.parse(wire).service_tier).toBe(tier);
      }
      expect(applyFastServiceTier(result, options)).toBe(result);
    }
  });

  it("does not invent absent model or stream fields", () => {
    const result = applyFastServiceTier({ input: [] }, {
      enabled: true, model: codexModel, usingOAuth: true,
    });
    expect(Object.keys(result as object)).toEqual(["service_tier", "input"]);
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
    expect(harness.commands.has("ultrafast")).toBe(true);
    expect(harness.pi.registerFlag).toHaveBeenCalledWith("ultrafast", expect.objectContaining({
      type: "boolean",
      default: false,
    }));
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

const astraModel = { ...codexModel, id: "gpt-6-astra" };

describe("UltraFast", () => {
  it("injects ultrafast without mutation and is idempotent", () => {
    const options = { enabled: true, model: astraModel as any, usingOAuth: true, tier: "ultrafast" as const };
    const payload = { model: astraModel.id, input: [], service_tier: "priority" };
    const result = applyFastServiceTier(payload, options);
    expect(result).toEqual({ ...payload, service_tier: "ultrafast" });
    expect(payload.service_tier).toBe("priority");
    expect(applyFastServiceTier(result, options)).toBe(result);
    expect(applyFastServiceTier({ model: codexModel.id }, options)).toEqual({ model: codexModel.id, service_tier: "ultrafast" });
    expect(applyFastServiceTier(null, options)).toBeNull();
    expect(applyFastServiceTier([], options)).toEqual([]);
  });

  it("leaves unsupported models and auth untouched", () => {
    const payload = { model: astraModel.id };
    const options = { enabled: true, model: astraModel as any, usingOAuth: true, tier: "ultrafast" as const };
    expect(applyFastServiceTier(payload, { ...options, model: codexModel as any })).toEqual({ ...payload, service_tier: "ultrafast" });
    expect(applyFastServiceTier(payload, { ...options, usingOAuth: false })).toBe(payload);
    expect(applyFastServiceTier(payload, { ...options, model: undefined })).toBe(payload);
    expect(applyFastServiceTier(payload, { ...options, model: { ...astraModel, provider: "openai" } as any })).toBe(payload);
    expect(applyFastServiceTier(payload, { ...options, enabled: false })).toBe(payload);
  });

  it("restores UltraFast state and ignores invalid tiers", () => {
    expect(restoreFastModeState([
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: true, tier: "ultrafast" } },
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: false, tier: "invalid" } },
    ])).toEqual({ enabled: true, tier: "ultrafast" });
  });

  it("switches modes exclusively, warns about entitlement, and persists", async () => {
    const h = createHarness({ model: astraModel });
    await h.commands.get("fast").handler("on", h.ctx);
    await h.commands.get("ultrafast").handler("on", h.ctx);
    expect(h.entries.at(-1)?.data).toEqual({ enabled: true, tier: "ultrafast" });
    expect(h.notifications.at(-1)).toEqual(expect.objectContaining({ level: "warning" }));
    expect(h.notifications.at(-1)?.message).toContain("Pro $200 is not supported");
    expect(h.statuses.at(-1)?.value).toContain("ultrafast (requested)");
    const event = { payload: { model: astraModel.id } };
    expect(await fire(h.handlers, "before_provider_request", event, h.ctx)).toEqual({ model: astraModel.id, service_tier: "ultrafast" });
    await h.commands.get("fast").handler("off", h.ctx);
    expect(h.entries.at(-1)?.data).toEqual({ enabled: true, tier: "ultrafast" });
    await h.commands.get("fast").handler("status", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("UltraFast mode is configured on instead");
    await h.commands.get("fast").handler("on", h.ctx);
    expect(await fire(h.handlers, "before_provider_request", event, h.ctx)).toEqual({ model: astraModel.id, service_tier: "priority" });
    await h.commands.get("ultrafast").handler("", h.ctx);
    await h.commands.get("ultrafast").handler("", h.ctx);
    expect(await fire(h.handlers, "before_provider_request", event, h.ctx)).toBeUndefined();
  });

  it("changes only future requests when switching or disabling during a response", async () => {
    const h = createHarness();
    const payload = { model: codexModel.id, input: [], stream: true };
    const request = () => fire(h.handlers, "before_provider_request", { payload }, h.ctx);
    await h.commands.get("fast").handler("on", h.ctx);
    const fastRequest = await request();
    const sentFast = JSON.stringify(fastRequest);
    await h.commands.get("ultrafast").handler("on", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("next provider request");
    expect(h.notifications.at(-1)?.message).toContain("in-flight response is unchanged");
    const ultraRequest = await request();
    expect(ultraRequest.service_tier).toBe("ultrafast");
    expect(JSON.stringify(fastRequest)).toBe(sentFast);
    await h.commands.get("fast").handler("on", h.ctx);
    expect((await request()).service_tier).toBe("priority");
    expect(ultraRequest.service_tier).toBe("ultrafast");
    await h.commands.get("fast").handler("off", h.ctx);
    expect(h.notifications.at(-1)?.message).toContain("in-flight response is unchanged");
    expect(await request()).toBeUndefined();
    expect(fastRequest.service_tier).toBe("priority");
    expect(payload).not.toHaveProperty("service_tier");
  });

  it("allows UltraFast for every Codex Responses model", async () => {
    const h = createHarness();
    await h.commands.get("fast").handler("on", h.ctx);
    await h.commands.get("ultrafast").handler("on", h.ctx);
    expect(h.entries.at(-1)?.data).toEqual({ enabled: true, tier: "ultrafast" });
    expect(h.notifications.at(-1)?.message).not.toContain("GPT-6 Astra");
    const apiKey = createHarness({ model: astraModel, oauth: false });
    await apiKey.commands.get("ultrafast").handler("on", apiKey.ctx);
    expect(apiKey.entries).toEqual([]);
    expect(apiKey.notifications.at(-1)?.message).toContain("OAuth");
  });

  it("restores flags and saved branch state, with saved off taking precedence", async () => {
    const h = createHarness({ model: astraModel, flag: true, ultraFlag: true });
    await fire(h.handlers, "session_start", {}, h.ctx);
    const event = { payload: { model: astraModel.id } };
    expect(await fire(h.handlers, "before_provider_request", event, h.ctx)).toEqual({ model: astraModel.id, service_tier: "ultrafast" });
    for (const lifecycle of ["session_start", "session_tree", "session_compact"]) {
      const restored = createHarness({ model: astraModel, branch: [
        { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: true, tier: "ultrafast" } },
      ] });
      await fire(restored.handlers, lifecycle, {}, restored.ctx);
      expect(await fire(restored.handlers, "before_provider_request", event, restored.ctx)).toEqual({ model: astraModel.id, service_tier: "ultrafast" });
    }
    const off = createHarness({ model: astraModel, ultraFlag: true, branch: [
      { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: false } },
    ] });
    await fire(off.handlers, "session_start", {}, off.ctx);
    expect(await fire(off.handlers, "before_provider_request", event, off.ctx)).toBeUndefined();
  });

  it("keeps UltraFast active when switching between Codex models", async () => {
    const h = createHarness({ model: astraModel });
    await h.commands.get("ultrafast").handler("on", h.ctx);
    h.ctx.model = codexModel;
    await fire(h.handlers, "model_select", { model: codexModel }, h.ctx);
    expect(h.statuses.at(-1)?.value).toContain("ultrafast");
    expect(await fire(h.handlers, "before_provider_request", { payload: { model: codexModel.id } }, h.ctx)).toEqual({ model: codexModel.id, service_tier: "ultrafast" });
    await h.commands.get("ultrafast").handler("status", h.ctx);
    expect(h.notifications.at(-1)?.message).not.toContain("inactive");
    h.ctx.model = astraModel;
    await fire(h.handlers, "model_select", { model: astraModel }, h.ctx);
    expect(h.statuses.at(-1)?.value).toContain("ultrafast");
    h.ctx.hasUI = false;
    await fire(h.handlers, "model_select", { model: astraModel }, h.ctx);
    expect(await fire(h.handlers, "before_provider_request", { payload: { model: astraModel.id } }, h.ctx)).toEqual({ model: astraModel.id, service_tier: "ultrafast" });
  });
});

describe("Fast mode startup defaults", () => {
  it("loads settings defaults, with flags and saved branch taking precedence", async () => {
    const cases = [
      { options: { defaultMode: "fast" as const }, expected: "priority" },
      { options: { defaultMode: "ultrafast" as const }, expected: "ultrafast" },
      { options: { defaultMode: "off" as const }, expected: undefined },
      { options: { defaultMode: "ultrafast" as const, flag: true }, expected: "priority" },
      { options: { defaultMode: "fast" as const, ultraFlag: true }, expected: "ultrafast" },
      { options: { defaultMode: "fast" as const, branch: [
        { type: "custom", customType: FAST_MODE_STATE_ENTRY, data: { enabled: false } },
      ] }, expected: undefined },
    ];
    for (const { options, expected } of cases) {
      const h = createHarness({ model: astraModel, ...options });
      await fire(h.handlers, "session_start", {}, h.ctx);
      const result = await fire(h.handlers, "before_provider_request", { payload: { model: astraModel.id } }, h.ctx);
      if (expected) expect(result.service_tier).toBe(expected);
      else expect(result).toBeUndefined();
    }
  });
});


describe("Fast parent configuration reader", () => {
  it.each([
    { flag: true }, { ultraFlag: true }, { defaultMode: "fast" as const },
    { defaultMode: "ultrafast" as const },
  ])("inherits startup settings without a persisted entry: %j", async (options) => {
    const h = createHarness(options);
    await fire(h.handlers, "session_start", {}, h.ctx);
    expect(h.entries).toEqual([]);
    const read = getFastModeReader(h.pi);
    expect(read()).toMatchObject({ enabled: true, tier:
      options.ultraFlag || options.defaultMode === "ultrafast" ? "ultrafast" : "priority" });
    await h.commands.get("fast").handler("on", h.ctx);
    expect(read()).toEqual({ enabled: true, tier: "priority" });
    await h.commands.get("fast").handler("off", h.ctx);
    expect(read().enabled).toBe(false);
  });

  it("isolates roots, returns a copy, and disables the reader on shutdown", async () => {
    const a = createHarness({ flag: true });
    const b = createHarness();
    await fire(a.handlers, "session_start", {}, a.ctx);
    await fire(b.handlers, "session_start", {}, b.ctx);
    const readA = getFastModeReader(a.pi), readB = getFastModeReader(b.pi);
    readA().enabled = false;
    expect(readA().enabled).toBe(true);
    expect(readB().enabled).toBe(false);
    await fire(a.handlers, "session_shutdown", {}, a.ctx);
    expect(readA().enabled).toBe(false);
    expect(getFastModeReader({ events: new EventEmitter() } as never)()).toEqual({ enabled: false });
  });

  it("a worker's local Fast state cannot override its parent-owned hook after compaction", async () => {
    const child = createHarness({ defaultMode: "ultrafast" });
    child.ctx.sessionManager.getSessionFile = () => "/tmp/fast-child-test";
    const release = registerForkWorker("/tmp/fast-child-test");
    try {
      await fire(child.handlers, "session_compact", {}, child.ctx);
      expect(await fire(child.handlers, "before_provider_request", { payload: { input: [] } }, child.ctx)).toBeUndefined();
    } finally { release(); }
  });
});
