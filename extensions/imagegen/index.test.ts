import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildCodexImageHeaders,
  buildEditRequest,
  buildGenerateRequest,
  extractCodexAccountId,
  postCodexImagesRequest,
  resolveCodexImagesUrl,
} from "./src/codex-images.js";
import { collectRecentImages } from "./src/session-images.js";
import {
  createImageGenTool,
  resolveCodexAuth,
  sanitizePathComponent,
} from "./src/tool.js";

function token(accountId = "acct_test"): string {
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `head.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

/** 1x1 transparent PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function okImageResponse(b64 = PNG_B64): Response {
  return new Response(
    JSON.stringify({
      created: 1778832973,
      background: "opaque",
      data: [{ b64_json: b64 }],
      quality: "medium",
      size: "1024x1024",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeCtx(overrides: Record<string, unknown> = {}): any {
  return {
    model: undefined,
    modelRegistry: {
      getAll: vi.fn(() => []),
      isUsingOAuth: vi.fn(() => false),
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: false, error: "none" })),
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
      getSessionId: vi.fn(() => "session-abc"),
    },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("resolveCodexImagesUrl", () => {
  it("appends /codex to the default pi codex baseUrl", () => {
    expect(resolveCodexImagesUrl("https://chatgpt.com/backend-api", "generations")).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
  });

  it("keeps an existing /codex suffix and strips trailing slashes", () => {
    expect(resolveCodexImagesUrl("https://chatgpt.com/backend-api/codex/", "edits")).toBe(
      "https://chatgpt.com/backend-api/codex/images/edits",
    );
  });

  it("falls back to the default base when none is configured", () => {
    expect(resolveCodexImagesUrl(undefined, "generations")).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
    expect(resolveCodexImagesUrl("  ", "generations")).toBe(
      "https://chatgpt.com/backend-api/codex/images/generations",
    );
  });

  it("rejects non-official or non-https endpoints", () => {
    expect(() => resolveCodexImagesUrl("https://evil.example.com/backend-api", "generations")).toThrow(
      "Unsupported Codex images endpoint",
    );
    expect(() => resolveCodexImagesUrl("http://chatgpt.com/backend-api", "generations")).toThrow(
      "Unsupported Codex images endpoint",
    );
    expect(() => resolveCodexImagesUrl("not a url", "generations")).toThrow(
      "Unsupported Codex images endpoint",
    );
  });
});

describe("extractCodexAccountId + buildCodexImageHeaders", () => {
  it("extracts the account id from the JWT auth claim", () => {
    expect(extractCodexAccountId(token("acct_123"))).toBe("acct_123");
    expect(extractCodexAccountId("garbage")).toBeUndefined();
  });

  it("builds codex-style headers with bearer token and originator", () => {
    const headers = buildCodexImageHeaders(token("acct_123"));
    expect(headers.Authorization).toMatch(/^Bearer head\./);
    expect(headers["chatgpt-account-id"]).toBe("acct_123");
    expect(headers.originator).toBe("pi");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("keeps extra headers but never lets them drop the bearer token", () => {
    const headers = buildCodexImageHeaders(token(), { "OpenAI-Beta": "responses=experimental" });
    expect(headers["OpenAI-Beta"]).toBe("responses=experimental");
    expect(headers.Authorization).toMatch(/^Bearer /);
  });
});

describe("postCodexImagesRequest", () => {
  it("posts a generate request and parses the image", async () => {
    const fetcher = vi.fn(async () => okImageResponse());
    const result = await postCodexImagesRequest("generations", buildGenerateRequest("a red fox"), {
      accessToken: token(),
      baseUrl: "https://chatgpt.com/backend-api",
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(result.b64).toBe(PNG_B64);
    expect(result.size).toBe("1024x1024");
    expect(result.quality).toBe("medium");

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(init.body as string)).toEqual({
      prompt: "a red fox",
      model: "gpt-image-2",
      background: "auto",
      quality: "auto",
      size: "auto",
    });
    expect((init.headers as Record<string, string>)["chatgpt-account-id"]).toBe("acct_test");
  });

  it("surfaces the API error message without leaking the token", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "content policy violation" } }), {
          status: 400,
        }),
    );
    await expect(
      postCodexImagesRequest("generations", buildGenerateRequest("x"), {
        accessToken: token(),
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("image generation failed (HTTP 400): content policy violation");
  });

  it("requires data-URL inputs for edits", async () => {
    await expect(
      postCodexImagesRequest("edits", buildEditRequest("x", ["https://example.com/a.png"]), {
        accessToken: token(),
        fetcher: vi.fn() as unknown as typeof fetch,
      }),
    ).rejects.toThrow("image edit inputs must be local files or conversation images");
  });

  it("rejects when the response has no image data", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ created: 1 }), { status: 200 }));
    await expect(
      postCodexImagesRequest("generations", buildGenerateRequest("x"), {
        accessToken: token(),
        fetcher: fetcher as unknown as typeof fetch,
      }),
    ).rejects.toThrow("Codex images returned no image data");
  });
});

describe("collectRecentImages", () => {
  const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });

  it("collects newest-first across messages, returned chronologically", () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }, img("old")] } },
      { type: "message", message: { role: "assistant", content: [img("assistant-ignored")] } },
      { type: "message", message: { role: "toolResult", content: [img("new")] } },
    ];
    expect(collectRecentImages(branch, 2)).toEqual([
      "data:image/png;base64,old",
      "data:image/png;base64,new",
    ]);
    expect(collectRecentImages(branch, 1)).toEqual(["data:image/png;base64,new"]);
  });

  it("ignores non-message entries and string content", () => {
    const branch = [
      { type: "custom", customType: "x" },
      { type: "message", message: { role: "user", content: "plain string" } },
    ];
    expect(collectRecentImages(branch, 3)).toEqual([]);
  });
});

describe("sanitizePathComponent", () => {
  it("replaces unsafe characters and never returns empty", () => {
    expect(sanitizePathComponent("abc/DEF-123_x")).toBe("abc_DEF-123_x");
    expect(sanitizePathComponent("///")).toBe("___");
    expect(sanitizePathComponent("")).toBe("generated_image");
  });
});

describe("resolveCodexAuth", () => {
  it("uses the current codex model when it is openai-codex", async () => {
    const codexModel = { provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" };
    const ctx = makeCtx({
      model: codexModel,
      modelRegistry: {
        getAll: vi.fn(() => [codexModel]),
        isUsingOAuth: vi.fn(() => true),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: token() })),
      },
    });
    const auth = await resolveCodexAuth(ctx);
    expect(auth.accessToken).toMatch(/^head\./);
    expect(auth.baseUrl).toBe("https://chatgpt.com/backend-api");
  });

  it("falls back to a registry codex model when the active model is another provider", async () => {
    const codexModel = { provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" };
    const ctx = makeCtx({
      model: { provider: "anthropic", id: "claude" },
      modelRegistry: {
        getAll: vi.fn(() => [codexModel]),
        isUsingOAuth: vi.fn(() => true),
        getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: token() })),
      },
    });
    await expect(resolveCodexAuth(ctx)).resolves.toBeDefined();
  });

  it("rejects API-key auth with a clear message", async () => {
    const codexModel = { provider: "openai-codex", id: "gpt-5.6-sol" };
    const ctx = makeCtx({
      model: codexModel,
      modelRegistry: {
        getAll: vi.fn(() => [codexModel]),
        isUsingOAuth: vi.fn(() => false),
        getApiKeyAndHeaders: vi.fn(),
      },
    });
    await expect(resolveCodexAuth(ctx)).rejects.toThrow("needs openai-codex OAuth login");
  });
});

describe("generate_image tool", () => {
  let saveRoot: string;

  afterEach(async () => {
    if (saveRoot) await rm(saveRoot, { recursive: true, force: true });
  });

  async function setup(opts: { returnImage?: boolean; authToken?: string } = {}) {
    saveRoot = await mkdtemp(join(tmpdir(), "imagegen-test-"));
    const fetcher = vi.fn(async () => okImageResponse());
    const tool = createImageGenTool({
      saveRoot,
      fetcher: fetcher as unknown as typeof fetch,
      shouldReturnImage: () => opts.returnImage !== false,
      resolveAuth: vi.fn(async () => ({
        accessToken: opts.authToken ?? token(),
        baseUrl: "https://chatgpt.com/backend-api",
      })),
    });
    return { tool, fetcher };
  }

  it("generates an image, saves it, and returns it to the model", async () => {
    const { tool, fetcher } = await setup();
    const ctx = makeCtx();
    const result = await tool.execute("call/1", { prompt: "a red fox" }, undefined, undefined, ctx);

    const image = result.content.find((b) => b.type === "image");
    expect(image).toBeDefined();
    expect((image as { data: string }).data).toBe(PNG_B64);
    const text = result.content.find((b) => b.type === "text");
    expect((text as { text: string }).text).toContain("session-abc");
    expect(result.details?.mode).toBe("generate");
    expect(result.details?.savedPath).toBe(join(saveRoot, "session-abc", "call_1.png"));

    const saved = await readFile(result.details!.savedPath!);
    expect(saved.toString("base64")).toBe(PNG_B64);

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
    expect(JSON.parse(init.body as string).prompt).toBe("a red fox");
  });

  it("omits the image block when returnImage is disabled", async () => {
    const { tool } = await setup({ returnImage: false });
    const result = await tool.execute("c1", { prompt: "x" }, undefined, undefined, makeCtx());
    expect(result.content.every((b) => b.type === "text")).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("imagegen-return-image=false");
  });

  it("edits referenced local images via the edits endpoint", async () => {
    const { tool, fetcher } = await setup();
    const inputPath = join(saveRoot, "input.png");
    await writeFile(inputPath, Buffer.from(PNG_B64, "base64"));
    const result = await tool.execute(
      "c2",
      { prompt: "make it blue", referenced_image_paths: [inputPath] },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(result.details?.mode).toBe("edit");
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://chatgpt.com/backend-api/codex/images/edits");
    const body = JSON.parse(init.body as string);
    expect(body.images).toHaveLength(1);
    expect(body.images[0].image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("edits recent conversation images when requested", async () => {
    const { tool, fetcher } = await setup();
    const ctx = makeCtx({
      sessionManager: {
        getBranch: vi.fn(() => [
          { type: "message", message: { role: "user", content: [{ type: "image", data: PNG_B64, mimeType: "image/png" }] } },
        ]),
        getSessionId: vi.fn(() => "session-abc"),
      },
    });
    const result = await tool.execute(
      "c3",
      { prompt: "make it blue", num_last_images_to_include: 1 },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details?.mode).toBe("edit");
    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url).toContain("/images/edits");
  });

  it("rejects invalid argument combinations before any network call", async () => {
    const { tool, fetcher } = await setup();
    const both = await tool.execute(
      "c4",
      { prompt: "x", referenced_image_paths: ["/tmp/a.png"], num_last_images_to_include: 1 },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(both.details?.error).toContain("provide only one of");
    expect(fetcher).not.toHaveBeenCalled();

    const empty = await tool.execute("c5", { prompt: "  " }, undefined, undefined, makeCtx());
    expect(empty.details?.error).toContain("non-empty prompt");

    const missing = await tool.execute(
      "c6",
      { prompt: "x", num_last_images_to_include: 2 },
      undefined,
      undefined,
      makeCtx(),
    );
    expect(missing.details?.error).toContain("only 0 were available");
  });

  it("propagates auth resolution failures as tool text", async () => {
    saveRoot = await mkdtemp(join(tmpdir(), "imagegen-test-"));
    const tool = createImageGenTool({
      saveRoot,
      fetcher: vi.fn() as unknown as typeof fetch,
      resolveAuth: vi.fn(async () => {
        throw new Error("generate_image uses the ChatGPT Codex subscription and needs openai-codex OAuth login");
      }),
    });
    const result = await tool.execute("c7", { prompt: "x" }, undefined, undefined, makeCtx());
    expect(result.details?.error).toContain("needs openai-codex OAuth login");
  });
});
