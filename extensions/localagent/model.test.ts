import { describe, expect, it, vi } from "vitest";
import { resolveAgentRuntime } from "./model.js";

function model(provider: string, id: string, name = id) {
  return { provider, id, name, reasoning: true } as never;
}

function harness(available: unknown[] = []) {
  const current = model("openai-codex", "gpt-5.6-sol");
  const pi = { getThinkingLevel: vi.fn(() => "max") } as never;
  const ctx = {
    model: current,
    modelRegistry: { getAvailable: () => available },
  } as never;
  return { pi, ctx, current };
}

describe("resolveAgentRuntime", () => {
  it("inherits the live parent model and thinking by default", () => {
    const { pi, ctx, current } = harness();
    expect(resolveAgentRuntime(pi, ctx, undefined, undefined)).toEqual({
      model: current,
      thinkingLevel: "max",
    });
  });

  it("lets an explicit tool model override agent frontmatter", () => {
    const haiku = model("anthropic", "claude-haiku-4-5");
    const opus = model("anthropic", "claude-opus-4-6");
    const { pi, ctx } = harness([opus, haiku]);
    expect(resolveAgentRuntime(pi, ctx, "haiku", "opus").model).toBe(haiku);
  });

  it("prefers Anthropic for Claude aliases when several providers match", () => {
    const copilot = model("github-copilot", "claude-sonnet-4.6");
    const anthropic = model("anthropic", "claude-sonnet-4-6");
    const { pi, ctx } = harness([copilot, anthropic]);
    expect(resolveAgentRuntime(pi, ctx, "sonnet", undefined).model).toBe(anthropic);
  });

  it("fails clearly instead of silently using an unrelated default", () => {
    const { pi, ctx } = harness([]);
    expect(() => resolveAgentRuntime(pi, ctx, "haiku", undefined)).toThrow(
      /No authenticated model matches alias "haiku"/,
    );
  });
});
