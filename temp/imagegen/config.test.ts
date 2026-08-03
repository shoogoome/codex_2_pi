import { describe, expect, it } from "vitest";
import { loadImageModelConfigFromJson } from "./config.js";

const configJson = JSON.stringify({
  providers: {
    "openai-image": {
      type: "image",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "OPENAI_API_KEY",
      api: "openai-responses",
      models: [],
      imageModels: [
        {
          id: "gpt-image-1",
          name: "GPT Image 1",
          api: "openai-images",
          defaultSize: "1024x1024",
          defaultFormat: "png",
        },
      ],
    },
    chat: {
      api: "openai-responses",
      models: [{ id: "gpt-4.1" }],
    },
  },
});

describe("loadImageModelConfigFromJson", () => {
  it("loads image providers without treating chat providers as image models", () => {
    const result = loadImageModelConfigFromJson(configJson);

    expect(result.providers).toHaveLength(1);
    expect(result.providers[0]).toMatchObject({
      name: "openai-image",
      type: "image",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "OPENAI_API_KEY",
    });
    expect(result.providers[0]?.imageModels).toEqual([
      {
        id: "gpt-image-1",
        name: "GPT Image 1",
        api: "openai-images",
        defaultSize: "1024x1024",
        defaultFormat: "png",
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  it("uses defaults for omitted image model options", () => {
    const result = loadImageModelConfigFromJson(JSON.stringify({
      providers: {
        img: {
          type: "image",
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test",
          imageModels: [{ id: "gpt-image-1", api: "openai-images" }],
        },
      },
    }));

    expect(result.providers[0]).toMatchObject({
      baseUrl: "https://api.openai.com/v1",
      imageModels: [
        {
          id: "gpt-image-1",
          name: "gpt-image-1",
          api: "openai-images",
          defaultSize: "1024x1024",
          defaultFormat: "png",
        },
      ],
    });
  });

  it("requires baseUrl so image providers remain compatible with Pi models.json validation", () => {
    const result = loadImageModelConfigFromJson(JSON.stringify({
      providers: {
        img: {
          type: "image",
          apiKey: "sk-test",
          imageModels: [{ id: "gpt-image-1", api: "openai-images" }],
        },
      },
    }));

    expect(result.providers).toEqual([]);
    expect(result.errors).toContain("Provider img: baseUrl is required for image providers.");
  });

  it("reports unsupported image APIs and missing required fields", () => {
    const result = loadImageModelConfigFromJson(JSON.stringify({
      providers: {
        bad: {
          type: "image",
          imageModels: [{ id: "foo", api: "replicate" }],
        },
      },
    }));

    expect(result.providers).toEqual([]);
    expect(result.errors).toContain("Provider bad: apiKey is required for image providers.");
    expect(result.errors).toContain("Provider bad, image model foo: api must be openai-images.");
  });
});
