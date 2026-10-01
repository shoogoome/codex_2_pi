import { create, toBinary } from "@bufbuild/protobuf";
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import { createCursorProvider } from "./provider.js";
import { encodeAvailableModelsRequest } from "./vendor/client/cursor-wire.js";
import { GetUsableModelsResponseSchema } from "./vendor/proto/agent_pb.js";
import { invalidateCursorModelCache } from "./vendor/stream/model-discovery.js";
import { resetCatalogCacheForTests } from "./vendor/stream/model-cache.js";
import { resetCacheDirForTests } from "./vendor/utils/cache-dir.js";

const transport = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock("./vendor/client/h2-unary.js", async (original) => ({
  ...await original<typeof import("./vendor/client/h2-unary.js")>(),
  supportsInProcessH2: () => true,
  callUnaryOverH2: transport.call,
}));

function requestFields(bytes: Uint8Array): Map<number, number> {
  const reader = new BinaryReader(bytes);
  const fields = new Map<number, number>();
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    if (wire === WireType.Varint) fields.set(field, reader.uint32());
    else reader.skip(wire);
  }
  return fields;
}

function advertisedModel(name: string): Uint8Array {
  const parameter = new BinaryWriter().tag(1, WireType.LengthDelimited).string("context")
    .tag(2, WireType.LengthDelimited).string("200k").finish();
  // Real Gemini 3.1 Pro metadata advertises one valid variant with no parameters.
  const variant = name === "gemini-3.1-pro" ? new Uint8Array()
    : new BinaryWriter().tag(1, WireType.LengthDelimited).bytes(parameter).finish();
  return new BinaryWriter().tag(1, WireType.LengthDelimited).string(name)
    .tag(17, WireType.LengthDelimited).string(name)
    .tag(18, WireType.LengthDelimited).string(name)
    .tag(30, WireType.LengthDelimited).bytes(variant).finish();
}

function availableResponse(names: string[]): Buffer {
  const writer = new BinaryWriter();
  for (const name of names) writer.tag(2, WireType.LengthDelimited).bytes(advertisedModel(name));
  return Buffer.from(writer.finish());
}

let cacheDir: string;
beforeEach(() => {
  vi.clearAllMocks();
  cacheDir = mkdtempSync(join(tmpdir(), "cursor-discovery-test-"));
  vi.stubEnv("PI_CURSOR_CACHE_DIR", cacheDir);
  vi.stubEnv("PI_CURSOR_PROVIDER_DEBUG", "0");
  resetCacheDirForTests();
  resetCatalogCacheForTests();
  invalidateCursorModelCache();
});
afterEach(() => {
  invalidateCursorModelCache();
  resetCatalogCacheForTests();
  resetCacheDirForTests();
  vi.unstubAllEnvs();
  rmSync(cacheDir, { recursive: true, force: true });
});

it("requests USER_AVAILABLE rather than unspecified/admin scope", () => {
  const fields = requestFields(encodeAvailableModelsRequest());
  expect(fields.get(5)).toBe(1); // use_model_parameters
  expect(fields.get(7)).toBe(1); // do_not_use_markdown
  expect(fields.get(10)).toBe(1); // AvailableModelsScope.USER_AVAILABLE (not ADMIN_SETTINGS_ALL_APPLICATION_MODELS = 3)
});

it("registers Claude, GPT and Gemini from the user's scoped catalog even when GetUsableModels omits them", async () => {
  const thirdParty = ["claude-sonnet-4-6", "gpt-5.4", "gemini-3.1-pro"];
  transport.call.mockImplementation(async ({ rpcPath, requestBody }: { rpcPath: string; requestBody: Uint8Array }) => {
    if (rpcPath === "/agent.v1.AgentService/GetUsableModels") {
      return { status: 200, body: Buffer.from(toBinary(GetUsableModelsResponseSchema, create(GetUsableModelsResponseSchema, {
        models: [{ modelId: "composer-2.5", displayName: "Composer" }],
      }))) };
    }
    expect(rpcPath).toBe("/aiserver.v1.AiService/AvailableModels");
    // Synthetic server reproduces the actual scope-dependent response observed during diagnosis.
    const names = requestFields(requestBody).get(10) === 1 ? thirdParty : ["composer-2.5"];
    return { status: 200, body: availableResponse(names) };
  });
  const runtime = createCursorProvider();
  try {
    await runtime.provider.refreshModels!({
      allowNetwork: true, force: true, signal: new AbortController().signal,
      credential: { type: "oauth", access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000 },
      publish: async ({ update }) => { update?.(); return true; },
    } satisfies RefreshModelsContext);
    expect(runtime.catalogSource()).toBe("live");
    const ids = runtime.provider.getModels().map((model) => model.id);
    expect(ids).toEqual(expect.arrayContaining(["composer-2.5", ...thirdParty]));
    expect(runtime.provider.getModels().some((model) => model.id.startsWith("gemini-3.1-pro-"))).toBe(false);
    expect(transport.call).toHaveBeenCalledTimes(2);
  } finally { runtime.stop(); }
});
