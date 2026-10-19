import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import codeBuddyReasoningExtension, { applyCodeBuddyReasoningPayload } from "./index.js";

const { streamSimple } = vi.hoisted(() => ({ streamSimple: vi.fn() }));
vi.mock("@earendil-works/pi-ai/compat", () => ({
  openAICompletionsApi: () => ({ streamSimple }),
}));

function getRegisteredStream() {
  const registerProvider = vi.fn();
  codeBuddyReasoningExtension({ registerProvider } as any);
  return registerProvider.mock.calls[0][1].streamSimple;
}

describe("codebuddy reasoning extension", () => {
  beforeEach(() => {
    streamSimple.mockReset();
  });

  it("loads through the TypeScript entry so Pi host dependency aliases apply", () => {
    const metadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
    expect(metadata.pi.extensions).toEqual(["index.ts"]);
    const buildScript = readFileSync(new URL("../../scripts/build-extensions.mjs", import.meta.url), "utf8");
    expect(buildScript).toMatch(/const SKIP = new Set\(\[[^\]]*"codebuddy-reasoning"/);
  });

  it("preserves transcript system messages, prompt sections, and dynamic tool declarations", () => {
    const codemode = { name: "codemode", description: "Run code", parameters: { type: "object" } };
    const context = {
      messages: [
        {
          role: "system",
          content: "Use the declared tools, not textual DSML.",
          sections: { guidelines: "Keep calls structured." },
          toolsAdded: [codemode],
          timestamp: 0,
        },
        { role: "user", content: "Read the docs", timestamp: 1 },
        {
          role: "system",
          content: [{ type: "text", text: "Updated instructions" }],
          sections: { guidelines: "Use the updated tool set." },
          toolsRemoved: [{ name: "codemode" }],
          toolsAdded: [{ ...codemode, name: "read" }],
          timestamp: 2,
        },
      ],
    };
    const model = { provider: "codebuddy", id: "deepseek-v4.1-flash" };
    const result = { marker: "original stream" };
    streamSimple.mockReturnValue(result);

    expect(getRegisteredStream()(model, context)).toBe(result);
    expect(streamSimple.mock.calls[0][0]).toBe(model);
    expect(streamSimple.mock.calls[0][1]).toBe(context);
    expect(context.messages[0].toolsAdded).toEqual([codemode]);
  });

  it("passes legacy context and stream options through without rewriting history", () => {
    const context = {
      systemPrompt: "Legacy prompt",
      tools: [{ name: "read", parameters: { type: "object" } }],
      messages: [
        { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "README.md" } }] },
        { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "docs" }] },
      ],
    };
    const options = {
      signal: new AbortController().signal,
      fetch: vi.fn(),
      onResponse: vi.fn(),
      onProviderStreamEvent: vi.fn(),
      headers: { "x-probe": "test" },
      reasoning: "high",
    };

    getRegisteredStream()({ provider: "codebuddy", id: "deepseek-v4.1-flash" }, context, options);

    expect(streamSimple.mock.calls[0][1]).toBe(context);
    expect(streamSimple.mock.calls[0][2]).toEqual({ ...options, onPayload: expect.any(Function) });
  });

  it("honors an upstream payload replacement before stripping legacy fields", async () => {
    const model = { provider: "codebuddy", id: "deepseek-v4.1-flash" };
    const replacement = { tools: [{ type: "function" }], verbosity: "high", reasoning_summary: "auto" };
    const onPayload = vi.fn().mockResolvedValue(replacement);
    getRegisteredStream()(model, { messages: [] }, { onPayload });

    const payload = { messages: [] };
    expect(await streamSimple.mock.calls[0][2].onPayload(payload, model)).toEqual({ tools: replacement.tools });
    expect(onPayload).toHaveBeenCalledWith(payload, model);
    expect(replacement).toHaveProperty("verbosity", "high");
  });

  it("keeps the original payload when an upstream observer returns nothing", async () => {
    const model = { provider: "codebuddy", id: "deepseek-v4.1-flash" };
    getRegisteredStream()(model, { messages: [] }, { onPayload: vi.fn() });
    const payload = { messages: [], tools: [{ type: "function" }], verbosity: "high" };

    expect(await streamSimple.mock.calls[0][2].onPayload(payload, model)).toEqual({ messages: [], tools: payload.tools });
  });

  it("registers an OpenAI completions stream override for CodeBuddy", () => {
    const registerProvider = vi.fn();

    codeBuddyReasoningExtension({ registerProvider } as any);

    expect(registerProvider).toHaveBeenCalledWith(
      "codebuddy",
      expect.objectContaining({
        api: "openai-completions",
        streamSimple: expect.any(Function),
      }),
    );
  });

  it("removes legacy fields rejected by the current CodeBuddy CLI gateway", () => {
    const payload = applyCodeBuddyReasoningPayload(
      {
        model: "gpt-5.6-sol",
        reasoning_effort: "high",
        temperature: 1,
        verbosity: "high",
        reasoning_summary: "auto",
      },
      { provider: "codebuddy", id: "gpt-5.6-sol" } as any,
      "high",
    );

    expect(payload).toEqual({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      temperature: 1,
    });
  });

  it("does not change a clean request", () => {
    const payload = { model: "gpt-5.6-sol", reasoning_effort: "high" };

    expect(
      applyCodeBuddyReasoningPayload(
        payload,
        { provider: "codebuddy", id: "gpt-5.6-sol" } as any,
        undefined,
      ),
    ).toEqual(payload);
  });

  it("does not alter other providers", () => {
    const payload = { reasoning_effort: "high", verbosity: "high" };

    expect(
      applyCodeBuddyReasoningPayload(
        payload,
        { provider: "openai", id: "gpt-5.6-sol" } as any,
        "high",
      ),
    ).toBe(payload);
  });
});
