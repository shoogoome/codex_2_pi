import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createGenerateImageTool } from "./tools.js";

const config = {
  providers: [
    {
      name: "openai-image",
      type: "image" as const,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "OPENAI_API_KEY",
      headers: {},
      imageModels: [
        {
          id: "gpt-image-1",
          name: "GPT Image 1",
          api: "openai-images" as const,
          defaultSize: "1024x1024" as const,
          defaultFormat: "png" as const,
        },
      ],
    },
  ],
  errors: [],
};

describe("createGenerateImageTool", () => {
  it("saves generated image, records a custom entry, and returns only text content", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-imagegen-tool-"));
    const appendEntry = vi.fn();
    const generate = vi.fn(async () => ({ base64: Buffer.from("img").toString("base64"), mimeType: "image/png", revisedPrompt: "revised" }));
    try {
      const tool = createGenerateImageTool({
        loadConfig: () => config,
        resolveSecret: () => "sk-test",
        generate,
        agentDir,
        now: () => new Date("2026-05-24T12:00:00Z"),
      });

      const result = await tool.execute("tool/1", { prompt: "draw a cat" }, undefined, undefined, { cwd: "/repo", appendEntry } as any);

      expect(result.content).toHaveLength(1);
      expect(result.content[0]).toMatchObject({ type: "text" });
      expect(result.content.some((block: any) => block.type === "image")).toBe(false);
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      expect(text).toContain("Generated image saved to:");
      expect(text).toContain("revised");
      expect(appendEntry).toHaveBeenCalledWith("codex-imagegen", expect.objectContaining({
        path: expect.stringContaining("generated_images/2026-05-24/tool_1.png"),
        source: "generated",
        prompt: "draw a cat",
        provider: "openai-image",
        model: "gpt-image-1",
        mimeType: "image/png",
      }));
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reports configuration errors when no image model is available", async () => {
    const tool = createGenerateImageTool({
      loadConfig: () => ({ providers: [], errors: ["bad config"] }),
      resolveSecret: () => "sk-test",
      generate: vi.fn(),
      agentDir: "/tmp/pi",
      now: () => new Date("2026-05-24T12:00:00Z"),
    });

    const result = await tool.execute("tool", { prompt: "draw" }, undefined, undefined, { appendEntry: vi.fn() } as any);

    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    expect(text).toContain("No image generation model configured.");
    expect(text).toContain("bad config");
  });
});
