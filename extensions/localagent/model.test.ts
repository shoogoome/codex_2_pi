import { describe, expect, it, vi } from "vitest";
import { inheritParentRuntime, resolveAgentRuntime } from "./model.js";

function model(provider: string, id: string, name = id) {
  return { provider, id, name, reasoning: true } as never;
}

function harness(available: unknown[] = [], parentProvider = "openai-codex") {
  const current = model("openai-codex", "gpt-5.6-sol");
  if (parentProvider !== "openai-codex") {
    (current as { provider: string }).provider = parentProvider;
  }
  const pi = { getThinkingLevel: vi.fn(() => "max") } as never;
  const ctx = {
    model: current,
    modelRegistry: { getAvailable: () => available },
  } as never;
  return { pi, ctx, current };
}

describe("inheritParentRuntime", () => {
  it("精确继承主会话 provider、model 对象和 thinking", () => {
    const current = model("custom-provider", "custom-model");
    const pi = { getThinkingLevel: vi.fn(() => "max") } as never;
    const ctx = { model: current } as never;

    expect(inheritParentRuntime(pi, ctx)).toEqual({
      model: current,
      thinkingLevel: "max",
    });
    expect(inheritParentRuntime(pi, ctx).model).toBe(current);
  });

  it("主会话没有活动模型时明确失败", () => {
    const pi = { getThinkingLevel: vi.fn(() => "medium") } as never;
    const ctx = { model: undefined } as never;

    expect(() => inheritParentRuntime(pi, ctx)).toThrow(/parent session has no active model/i);
  });
});

describe("resolveAgentRuntime", () => {
  it("默认继承活动主会话模型与 thinking", () => {
    const { pi, ctx, current } = harness();
    expect(resolveAgentRuntime(pi, ctx, undefined, undefined)).toEqual({
      model: current,
      thinkingLevel: "max",
    });
  });

  it("显式请求的 model 覆盖 role frontmatter", () => {
    const haiku = model("anthropic", "claude-haiku-4-5");
    const opus = model("anthropic", "claude-opus-4-6");
    const { pi, ctx } = harness([opus, haiku]);
    expect(resolveAgentRuntime(pi, ctx, "haiku", "opus").model).toBe(haiku);
  });

  it("多个 provider 匹配时优先 Anthropic", () => {
    const copilot = model("github-copilot", "claude-sonnet-4.6");
    const anthropic = model("anthropic", "claude-sonnet-4-6");
    const { pi, ctx } = harness([copilot, anthropic]);
    expect(resolveAgentRuntime(pi, ctx, "sonnet", undefined).model).toBe(anthropic);
  });

  it("无匹配模型时明确失败，不静默用无关默认值", () => {
    const { pi, ctx } = harness([]);
    expect(() => resolveAgentRuntime(pi, ctx, "haiku", undefined)).toThrow(
      /No authenticated model matches alias "haiku"/,
    );
  });

  it("role 声明 model 时优先在主会话 provider 内解析，不跨 provider", () => {
    // Leader runs on a non-Anthropic provider, but that provider also serves a
    // sonnet model. The teammate must stay on the leader's provider instead of
    // jumping to Anthropic.
    const localSonnet = model("codebuddy", "deepseek-sonnet-x");
    const anthropic = model("anthropic", "claude-sonnet-4-6");
    const { pi, ctx } = harness([anthropic, localSonnet], "codebuddy");

    expect(resolveAgentRuntime(pi, ctx, undefined, "sonnet").model).toBe(localSonnet);
  });

  it("主会话 provider 无匹配时，才回退到全局别名排序", () => {
    const anthropic = model("anthropic", "claude-haiku-4-5");
    const { pi, ctx } = harness([anthropic], "codebuddy");

    expect(resolveAgentRuntime(pi, ctx, "haiku", undefined).model).toBe(anthropic);
  });

  it("主会话 provider 内多个匹配时保持 provider 不变", () => {
    const copilot = model("github-copilot", "claude-sonnet-4.6");
    const anthropic = model("anthropic", "claude-sonnet-4-6");
    const { pi, ctx } = harness([copilot, anthropic], "github-copilot");

    expect(resolveAgentRuntime(pi, ctx, "sonnet", undefined).model).toBe(copilot);
  });

  it("错误信息里带上主会话 provider", () => {
    const { pi, ctx } = harness([], "codebuddy");
    expect(() => resolveAgentRuntime(pi, ctx, "haiku", undefined)).toThrow(
      /on provider "codebuddy"/,
    );
  });
});
