import { describe, expect, it, vi } from "vitest";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { completeSideWithOverflowRetry, isSideContextOverflow } from "./side-request.js";

function response(stopReason: AssistantMessage["stopReason"], errorMessage?: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: 1,
  };
}

const initial = [{ role: "user", content: [{ type: "text", text: "initial" }], timestamp: 1 }] as Message[];
const emergency = [{ role: "user", content: [{ type: "text", text: "emergency" }], timestamp: 1 }] as Message[];

describe("side overflow recovery", () => {
  it("recognizes the Codex context-window error", () => {
    expect(isSideContextOverflow(response("error", "Codex error: Your input exceeds the context window of this model."))).toBe(true);
    expect(isSideContextOverflow(response("error", "Our servers are overloaded"))).toBe(false);
  });

  it("retries once with emergency messages after an overflow", async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce(response("error", "Your input exceeds the context window"))
      .mockResolvedValueOnce(response("stop"));

    const result = await completeSideWithOverflowRetry(initial, () => emergency, complete);

    expect(result.stopReason).toBe("stop");
    expect(complete).toHaveBeenNthCalledWith(1, initial);
    expect(complete).toHaveBeenNthCalledWith(2, emergency);
  });

  it("does not retry unrelated provider errors", async () => {
    const failed = response("error", "Our servers are overloaded");
    const complete = vi.fn().mockResolvedValue(failed);

    expect(await completeSideWithOverflowRetry(initial, () => emergency, complete)).toBe(failed);
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
