import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runSide } from "./index.js";
import { SideOverlay, type SideOverlayController } from "./side-overlay.js";
import { SIDE_BOUNDARY_PROMPT, SIDE_DEVELOPER_INSTRUCTIONS } from "./side-prompt.js";

const complete = vi.fn<ExtensionContext["modelRegistry"]["complete"]>();
vi.mock("./side-overlay.js", () => ({
  SIDE_OVERLAY_MAX_HEIGHT: "95%",
  SideOverlay: vi.fn(function () {}),
}));

afterEach(() => {
  vi.clearAllMocks();
  complete.mockReset();
});

function response(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant", content, stopReason,
    api: "openai-codex-responses", provider: "openai-codex", model: "test", timestamp: 2,
    usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function startSide() {
  let close!: () => void;
  const parentEntries = [{
    type: "message", id: "parent", parentId: null, timestamp: "2026-01-01",
    message: { role: "user", content: "Read files and keep working", timestamp: 1 },
  }];
  const ctx = {
    hasUI: true,
    model: { provider: "openai-codex", contextWindow: 10000, maxTokens: 2000 },
    modelRegistry: { complete, getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "test" })) },
    sessionManager: { getEntries: () => parentEntries, getLeafId: () => "parent" },
    ui: {
      notify: vi.fn(),
      custom: vi.fn((factory: any) => new Promise<void>((resolve) => {
        close = resolve;
        factory({ terminal: { rows: 30 }, requestRender: vi.fn(), addInputListener: () => vi.fn() }, {}, {}, resolve);
      })),
    },
  };
  const finished = runSide("Explain the current context", ctx as any, { getFlag: () => false } as any);
  const controller = vi.mocked(SideOverlay).mock.calls[0][1] as SideOverlayController;
  return { close, finished, controller, parentEntries };
}

describe("side model requests", () => {
  it("sends explicit no-tool instructions with a boundary after parent history on every user turn", async () => {
    complete.mockResolvedValue(response([{ type: "text", text: "Direct answer" }]));
    const { close, finished, controller, parentEntries } = startSide();
    try {
      await vi.waitFor(() => expect(controller.getStatus()).toBe("idle"));
      const context = complete.mock.calls[0][1];
      expect(context.systemPrompt).toBe(SIDE_DEVELOPER_INSTRUCTIONS);
      expect(context.tools).toEqual([]);
      expect(context.messages.map((message) => message.content)).toEqual([
        parentEntries[0].message.content,
        [{ type: "text", text: SIDE_BOUNDARY_PROMPT }],
        [{ type: "text", text: "Explain the current context" }],
      ]);
      expect(complete).toHaveBeenCalledTimes(1);
      controller.send("Follow up");
      await vi.waitFor(() => expect(controller.getStatus()).toBe("idle"));
      expect(complete).toHaveBeenCalledTimes(2);
      expect(complete.mock.calls[1][1].messages).toHaveLength(5);
      expect(parentEntries).toHaveLength(1);
    } finally {
      close();
      await finished;
    }
  });

  it("rejects unexpected tool calls without executing or retaining them as a successful side turn", async () => {
    complete.mockResolvedValueOnce(response([
      { type: "text", text: "I will inspect files" },
      { type: "toolCall", id: "call", name: "read", arguments: { path: "a" } },
    ], "toolUse")).mockResolvedValue(response([{ type: "text", text: "Answer" }]));
    const { close, finished, controller } = startSide();
    try {
      await vi.waitFor(() => expect(controller.getStatus()).toBe("failed"));
      expect(controller.getTranscript().at(-1)).toEqual({
        role: "system", text: "Tools are unavailable in /side. Continue requests requiring tools in the main conversation.",
      });
      expect(controller.getTranscript().some((entry) => entry.role === "assistant")).toBe(false);
      expect(complete).toHaveBeenCalledTimes(1);
      controller.send("Answer without tools");
      await vi.waitFor(() => expect(controller.getStatus()).toBe("idle"));
      expect(complete.mock.calls[1][1].messages).toHaveLength(3);
    } finally {
      close();
      await finished;
    }
  });
});
