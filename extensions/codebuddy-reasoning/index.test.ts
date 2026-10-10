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
