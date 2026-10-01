import { createModels, type AssistantMessageEvent, type Context, type Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cursorExtension from "./index.js";
import { createCursorProvider } from "./provider.js";
import { getCursorAgentUrl } from "./vendor/config/index.js";
import { withCursorRequest } from "./vendor/client/request-context.js";
import { resolveCursorProxyUrl } from "./vendor/client/h2-proxy.js";

afterEach(() => { vi.unstubAllEnvs(); });

const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } as Context;

function host(enabled = true) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, { handler: (...args: any[]) => any }>();
  const registerProvider = vi.fn();
  const api = {
    registerFlag: vi.fn(), getFlag: () => enabled,
    registerProvider,
    on: (event: string, handler: (...args: any[]) => any) => { handlers.set(event, handler); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
  } as unknown as ExtensionAPI;
  return { api, handlers, commands, registerProvider };
}

it("registers a native provider and supports disabling the extension", () => {
  const disabled = host(false);
  cursorExtension(disabled.api);
  expect(disabled.registerProvider).not.toHaveBeenCalled();
  const enabled = host();
  cursorExtension(enabled.api);
  const provider = enabled.registerProvider.mock.calls[0][0] as Provider;
  expect(provider.id).toBe("cursor");
  expect(provider.auth.oauth?.isSubscription).toBe(true);
  expect(provider.getModels().length).toBeGreaterThan(0);
  expect(enabled.handlers.has("session_compact")).toBe(true);
  expect(enabled.commands.has("cursor")).toBe(true);
  enabled.handlers.get("session_shutdown")!();
});

it("derives request authentication only from the supplied Pi credential", async () => {
  const { provider } = createCursorProvider();
  const credential = { type: "oauth" as const, access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 60_000 };
  await expect(provider.auth.oauth!.toAuth(credential)).resolves.toEqual({ apiKey: "fake-access" });
  const signal = new AbortController().signal;
  const ctx = { env: vi.fn().mockResolvedValue(undefined), fileExists: vi.fn() };
  await expect(provider.auth.apiKey!.resolve({ ctx, signal })).resolves.toBeUndefined();
  expect(ctx.fileExists).not.toHaveBeenCalled();
});

it("works with the actual Pi Models authentication runtime without reading files", async () => {
  const runtime = createCursorProvider();
  const credential = { type: "oauth" as const, access: "synthetic-runtime-access", refresh: "synthetic-runtime-refresh", expires: Date.now() + 3_600_000 };
  const credentials = { read: vi.fn(async () => credential), list: vi.fn(async () => []), modify: vi.fn(), delete: vi.fn() };
  const models = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(runtime.provider);
  expect((await models.getAvailable("cursor")).length).toBeGreaterThan(0);
  expect((await models.getAuth("cursor"))?.auth.apiKey).toBe("synthetic-runtime-access");
  expect(credentials.modify).not.toHaveBeenCalled();
  runtime.stop();
});

it("redacts the current opaque access token from provider errors", async () => {
  const runtime = createCursorProvider();
  const stream = runtime.provider.streamSimple(runtime.provider.getModels()[0], context, {
    apiKey: "opaque-secret-token",
    onPayload: () => { throw new Error("Server echoed opaque-secret-token"); },
  });
  expect((await stream.result()).errorMessage).toBe("Server echoed [redacted]");
  runtime.stop();
});

it("does not make model discovery requests during offline refresh", async () => {
  const runtime = createCursorProvider();
  const fetchImpl = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network"));
  try {
    const publish = vi.fn();
    await runtime.provider.refreshModels!({ allowNetwork: false, signal: new AbortController().signal, publish });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  } finally { fetchImpl.mockRestore(); runtime.stop(); }
});

it("cancels before request setup and can restart for a replacement Pi session", async () => {
  const runtime = createCursorProvider();
  const model = runtime.provider.getModels()[0];
  runtime.stop();
  const events: AssistantMessageEvent[] = [];
  const stream = runtime.provider.streamSimple(model, context, { apiKey: "fake-access" });
  for await (const event of stream) events.push(event);
  expect(events.map((e) => e.type)).toEqual(["error"]);
  expect((await stream.result()).stopReason).toBe("aborted");
  runtime.start();
  const next = runtime.provider.streamSimple(model, context, { onPayload: () => { throw new Error("test-hook"); } });
  expect((await next.result()).errorMessage).toBe("test-hook");
  runtime.stop();
});

it("fails missing authentication and unsupported fetch explicitly without a start event", async () => {
  const runtime = createCursorProvider();
  const model = runtime.provider.getModels()[0];
  const missing = runtime.provider.streamSimple(model, context);
  expect((await missing.result()).errorMessage).toContain("/login cursor");
  const custom = runtime.provider.streamSimple(model, context, { apiKey: "fake", fetch: vi.fn() });
  expect((await custom.result()).errorMessage).toContain("custom fetch");
  runtime.stop();
});

it("keeps provider-scoped endpoint/proxy env isolated across concurrent requests", async () => {
  const runtime = createCursorProvider();
  const model = runtime.provider.getModels()[0];
  const read = (suffix: string) => withCursorRequest(model, {
    env: { PI_CURSOR_AGENT_URL: `https://${suffix}.cursor.sh`, PI_PROXY_CURSOR: `http://${suffix}.example:8080` },
  }, async () => {
    await Promise.resolve();
    return [getCursorAgentUrl(), resolveCursorProxyUrl()?.hostname];
  });
  expect(await Promise.all([read("one"), read("two")])).toEqual([
    ["https://one.cursor.sh", "one.example"], ["https://two.cursor.sh", "two.example"],
  ]);
  runtime.stop();
});
