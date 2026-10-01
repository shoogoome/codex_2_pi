import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { createCursorProvider } from "./provider.js";

const discovery = vi.hoisted(() => ({ discover: vi.fn(), invalidate: vi.fn() }));
vi.mock("./vendor/stream/model-discovery.js", async (original) => ({
  ...await original<typeof import("./vendor/stream/model-discovery.js")>(),
  discoverCursorCatalog: discovery.discover,
  invalidateCursorModelCache: discovery.invalidate,
}));

beforeEach(() => { vi.clearAllMocks(); });

function refreshContext(publish: RefreshModelsContext["publish"]): RefreshModelsContext {
  return {
    allowNetwork: true, force: true, signal: new AbortController().signal, publish,
    credential: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 },
  };
}

it("forces live discovery and publishes models through Pi's generation-checked update", async () => {
  const runtime = createCursorProvider();
  discovery.discover.mockResolvedValue({
    rawModels: [{ id: "synthetic-model", name: "Fixture", contextWindow: 100_000, maxTokens: 4096, reasoning: false, supportsImages: false }],
    parameterizedModels: [],
  });
  const publish = vi.fn(async ({ update }: { update?: () => void }) => { update?.(); return true; });
  await runtime.provider.refreshModels!(refreshContext(publish));
  expect(discovery.invalidate).toHaveBeenCalledOnce();
  expect(discovery.discover.mock.calls[0][0]).toBe("synthetic-access");
  expect(runtime.catalogSource()).toBe("live");
  expect(runtime.provider.getModels().map((m) => m.id)).toContain("synthetic-model");
  expect(runtime.provider.getModels().find((m) => m.id === "synthetic-model")?.input).toEqual(["text"]);
  runtime.stop();
});

it("does not install a catalog when Pi rejects a stale publication", async () => {
  const runtime = createCursorProvider();
  discovery.discover.mockResolvedValue({ rawModels: [{ id: "stale-model", name: "Stale", contextWindow: 100_000, maxTokens: 4096, reasoning: false }], parameterizedModels: [] });
  await runtime.provider.refreshModels!(refreshContext(async () => false));
  expect(runtime.catalogSource()).toBe("fallback");
  expect(runtime.provider.getModels().some((m) => m.id === "stale-model")).toBe(false);
  runtime.stop();
});

it("reports empty discovery while keeping the previous catalog", async () => {
  const runtime = createCursorProvider();
  const before = runtime.provider.getModels().map((m) => m.id);
  discovery.discover.mockResolvedValue({ rawModels: [], parameterizedModels: [] });
  await expect(runtime.provider.refreshModels!(refreshContext(async () => true))).rejects.toThrow("模型发现");
  expect(runtime.provider.getModels().map((m) => m.id)).toEqual(before);
  runtime.stop();
});

it("cancels discovery on shutdown and prevents late publication", async () => {
  const runtime = createCursorProvider();
  let complete!: (value: unknown) => void;
  discovery.discover.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
  const publish = vi.fn();
  const pending = runtime.provider.refreshModels!(refreshContext(publish));
  const rejected = expect(pending).rejects.toThrow();
  runtime.stop();
  expect(discovery.discover.mock.calls[0][1].signal.aborted).toBe(true);
  complete({ rawModels: [{ id: "late", name: "Late", contextWindow: 100_000, maxTokens: 4096 }], parameterizedModels: [] });
  await rejected;
  expect(publish).not.toHaveBeenCalled();
});
