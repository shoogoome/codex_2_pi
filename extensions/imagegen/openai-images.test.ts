import { describe, expect, it, vi } from "vitest";
import { generateOpenAIImage } from "./openai-images.js";

const provider = {
  name: "openai-image",
  type: "image" as const,
  baseUrl: "https://api.openai.com/v1",
  apiKey: "OPENAI_API_KEY",
  headers: { "x-test": "yes" },
  imageModels: [],
};

const model = {
  id: "gpt-image-1",
  name: "GPT Image 1",
  api: "openai-images" as const,
  defaultSize: "1024x1024" as const,
  defaultFormat: "png" as const,
};

describe("generateOpenAIImage", () => {
  it("posts to OpenAI images API and returns base64 image data", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ b64_json: Buffer.from("png-bytes").toString("base64"), revised_prompt: "better prompt" }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

    const result = await generateOpenAIImage({
      provider,
      model,
      apiKey: "sk-test",
      prompt: "draw a cat",
      size: "1536x1024",
      outputFormat: "png",
      fetch,
    });

    expect(result).toEqual({
      base64: Buffer.from("png-bytes").toString("base64"),
      mimeType: "image/png",
      revisedPrompt: "better prompt",
    });
    expect(fetch).toHaveBeenCalledWith("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-test",
        "Content-Type": "application/json",
        "x-test": "yes",
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: "draw a cat",
        size: "1536x1024",
        output_format: "png",
        n: 1,
      }),
      signal: undefined,
    });
  });

  it("accepts data URL image payloads from OpenAI", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      data: [{ url: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` }],
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

    const result = await generateOpenAIImage({
      provider,
      model,
      apiKey: "sk-test",
      prompt: "draw a cat",
      size: "1024x1024",
      outputFormat: "png",
      fetch,
    });

    expect(result.base64).toBe(Buffer.from("png-bytes").toString("base64"));
    expect(result.mimeType).toBe("image/png");
  });

  it("surfaces API errors with status and response text", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { message: "bad prompt" } }), { status: 400 })) as unknown as typeof globalThis.fetch;

    await expect(generateOpenAIImage({
      provider,
      model,
      apiKey: "sk-test",
      prompt: "bad",
      size: "1024x1024",
      outputFormat: "png",
      fetch,
    })).rejects.toThrow("OpenAI Images API failed with 400: bad prompt");
  });
});
