import { describe, expect, it, vi } from "vitest";
import codeBuddyReasoningExtension, { applyCodeBuddyReasoningPayload } from "./index.js";

describe("codebuddy reasoning extension", () => {
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

  it("adds the native CodeBuddy visible-reasoning parameters for gpt-5.6-sol", () => {
    const payload = applyCodeBuddyReasoningPayload(
      { model: "gpt-5.6-sol", reasoning_effort: "high", temperature: 0 },
      { provider: "codebuddy", id: "gpt-5.6-sol" } as any,
      "high",
    );

    expect(payload).toEqual({
      model: "gpt-5.6-sol",
      reasoning_effort: "high",
      temperature: 1,
      verbosity: "high",
      reasoning_summary: "auto",
    });
  });

  it("does not alter requests when thinking is off", () => {
    const payload = { model: "gpt-5.6-sol" };

    expect(
      applyCodeBuddyReasoningPayload(
        payload,
        { provider: "codebuddy", id: "gpt-5.6-sol" } as any,
        undefined,
      ),
    ).toBe(payload);
  });

  it("does not alter other providers or CodeBuddy models", () => {
    const payload = { reasoning_effort: "high" };

    expect(
      applyCodeBuddyReasoningPayload(
        payload,
        { provider: "openai", id: "gpt-5.6-sol" } as any,
        "high",
      ),
    ).toBe(payload);
    expect(
      applyCodeBuddyReasoningPayload(
        payload,
        { provider: "codebuddy", id: "gpt-5.6-terra" } as any,
        "high",
      ),
    ).toBe(payload);
  });
});
