import { describe, expect, it } from "vitest";
import {
  defaultEffortForModel,
  nextEffort,
  reasoningOptionsForModel,
} from "./reasoning.js";

describe("reasoning model catalog", () => {
  it("matches Codex GPT-5.6 Sol/Terra and keeps Ultra advanced", () => {
    const options = reasoningOptionsForModel(
      { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
      true,
    );
    expect(options.map((option) => option.level)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
      "ultra",
    ]);
    expect(options.filter((option) => option.advanced).map((option) => option.level)).toEqual([
      "max",
      "ultra",
    ]);
  });

  it("matches Luna through Max without Ultra", () => {
    const options = reasoningOptionsForModel(
      { provider: "openai-codex", id: "gpt-5.6-luna", reasoning: true },
      false,
    );
    expect(options.map((option) => option.level)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("falls back to Pi thinkingLevelMap for unrelated models", () => {
    const options = reasoningOptionsForModel(
      {
        provider: "example",
        id: "reasoner",
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: null },
      },
      false,
    );
    expect(options.map((option) => option.level)).toEqual([
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
  });
});

describe("reasoning shortcut order", () => {
  const options = reasoningOptionsForModel(
    { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true },
    true,
  );

  it("anchors unsupported state to the model default", () => {
    expect(defaultEffortForModel(options, "minimal")).toBe("medium");
  });

  it("steps Ultra down to Max and Extra high up toward Max", () => {
    expect(nextEffort(options, "ultra", "lower")).toBe("max");
    expect(nextEffort(options, "xhigh", "raise")).toBe("max");
  });
});
