import { describe, expect, it, vi } from "vitest";
import { inheritParentRuntime } from "./model.js";

function model(provider: string, id: string, name = id) {
  return { provider, id, name, reasoning: true } as never;
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
