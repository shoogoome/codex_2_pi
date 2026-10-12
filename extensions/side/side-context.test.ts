import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { SIDE_BOUNDARY_PROMPT } from "./side-prompt.js";
import {
  buildSideMessages,
  detachProviderContinuationState,
  emergencySideInputBudget,
  sideInputBudget,
  type SideSessionReader,
} from "./side-context.js";

function user(text: string, timestamp = 1): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistant(text: string, timestamp = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function reader(entries: SessionEntry[], leafId = entries.at(-1)?.id ?? null): SideSessionReader {
  return {
    getEntries: () => entries,
    getLeafId: () => leafId,
  };
}

function textOf(messages: Message[]): string {
  const text: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      text.push(message.content);
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") text.push(block.text);
    }
  }
  return text.join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("side context construction", () => {
  it("uses Pi's compaction-aware session context instead of resurrecting compacted messages", () => {
    const entries = [
      { type: "message", id: "old-u", parentId: null, timestamp: "2026-01-01", message: user("OLD HUGE CONTEXT") },
      { type: "message", id: "old-a", parentId: "old-u", timestamp: "2026-01-01", message: assistant("old answer") },
      { type: "message", id: "kept-u", parentId: "old-a", timestamp: "2026-01-01", message: user("KEPT QUESTION") },
      { type: "message", id: "kept-a", parentId: "kept-u", timestamp: "2026-01-01", message: assistant("kept answer") },
      {
        type: "compaction",
        id: "compact",
        parentId: "kept-a",
        timestamp: "2026-01-01",
        summary: "SUMMARY OF OLD CONTEXT",
        firstKeptEntryId: "kept-u",
        tokensBefore: 250000,
      },
      { type: "message", id: "after", parentId: "compact", timestamp: "2026-01-01", message: user("AFTER COMPACTION") },
    ] as SessionEntry[];

    const messages = buildSideMessages(reader(entries), [], user("SIDE QUESTION"), {
      contextPipelineEnabled: false,
    });
    const text = textOf(messages);

    expect(text).not.toContain("OLD HUGE CONTEXT");
    expect(text).toContain("SUMMARY OF OLD CONTEXT");
    expect(text).toContain("KEPT QUESTION");
    expect(text).toContain("AFTER COMPACTION");
    expect(text).toContain("SIDE QUESTION");
  });

  it("applies the normal context-pipeline tool-result cap before a side request", () => {
    vi.stubEnv("PI_CTXPIPE_PER_BLOCK", "100");
    vi.stubEnv("PI_CTXPIPE_PER_BATCH", "1000");
    vi.stubEnv("PI_CTXPIPE_PRUNE_MODE", "manual");

    const huge = "x".repeat(1000);
    const entries = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01", message: user("inspect") },
      { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01", message: {
        ...assistant(""),
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "large.txt" } }],
      } },
      { type: "message", id: "t", parentId: "a", timestamp: "2026-01-01", message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: huge }],
        isError: false,
        timestamp: 3,
      } },
    ] as SessionEntry[];

    const messages = buildSideMessages(reader(entries), [], user("what happened?"));
    const text = textOf(messages);

    expect(text).not.toContain(huge);
    expect(text.replace(SIDE_BOUNDARY_PROMPT, "").length).toBeLessThan(500);
    expect(text).toContain("what happened?");
  });

  it("removes custom messages that the main context hooks mark as LLM-invisible", () => {
    const entries = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01", message: user("parent") },
      {
        type: "custom_message",
        id: "progress",
        parentId: "u",
        timestamp: "2026-01-01",
        customType: "tasks/progress",
        content: "HIDDEN PROGRESS",
        display: true,
      },
      {
        type: "custom_message",
        id: "hidden-note",
        parentId: "progress",
        timestamp: "2026-01-01",
        customType: "tasks/notification",
        content: "HIDDEN NOTIFICATION",
        display: true,
        details: { extra: { llmVisible: false } },
      },
      {
        type: "custom_message",
        id: "visible-note",
        parentId: "hidden-note",
        timestamp: "2026-01-01",
        customType: "tasks/notification",
        content: "VISIBLE NOTIFICATION",
        display: true,
        details: { extra: { llmVisible: true } },
      },
    ] as SessionEntry[];

    const text = textOf(buildSideMessages(reader(entries), [], user("side"), {
      contextPipelineEnabled: false,
    }));

    expect(text).not.toContain("HIDDEN PROGRESS");
    expect(text).not.toContain("HIDDEN NOTIFICATION");
    expect(text).toContain("VISIBLE NOTIFICATION");
  });

  it("detaches encrypted reasoning and Responses item IDs from reference history", () => {
    const source = [
      {
        ...assistant(""),
        responseId: "resp-parent",
        content: [
          { type: "thinking", thinking: "summary", thinkingSignature: JSON.stringify({ encrypted_content: "x".repeat(10000) }) },
          { type: "text", text: "visible answer", textSignature: JSON.stringify({ id: "msg-parent" }) },
          { type: "toolCall", id: "call-1|fc-parent", name: "read", arguments: { path: "a" }, thoughtSignature: "provider-state" },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call-1|fc-parent",
        toolName: "read",
        content: [{ type: "text", text: "result" }],
        isError: false,
        timestamp: 3,
      },
    ] as Message[];

    const detached = detachProviderContinuationState(source);
    const detachedAssistant = detached[0] as AssistantMessage;
    const detachedTool = detached[1] as Extract<Message, { role: "toolResult" }>;

    expect(detachedAssistant.content.some((block) => block.type === "thinking")).toBe(false);
    expect(detachedAssistant.responseId).toBeUndefined();
    expect(detachedAssistant.content.find((block) => block.type === "text")).not.toHaveProperty("textSignature");
    expect(detachedAssistant.content.find((block) => block.type === "toolCall")).toMatchObject({ id: "call-1" });
    expect(detachedAssistant.content.find((block) => block.type === "toolCall")).not.toHaveProperty("thoughtSignature");
    expect(detachedTool.toolCallId).toBe("call-1");
  });

  it("drops old inherited turns locally when the direct side request exceeds its budget", () => {
    const entries = [
      { type: "message", id: "u1", parentId: null, timestamp: "2026-01-01", message: user(`OLD-${"a".repeat(400)}`) },
      { type: "message", id: "a1", parentId: "u1", timestamp: "2026-01-01", message: assistant(`OLD-A-${"b".repeat(400)}`) },
      { type: "message", id: "u2", parentId: "a1", timestamp: "2026-01-01", message: user(`RECENT-${"c".repeat(400)}`) },
      { type: "message", id: "a2", parentId: "u2", timestamp: "2026-01-01", message: assistant(`RECENT-A-${"d".repeat(400)}`) },
    ] as SessionEntry[];

    const messages = buildSideMessages(reader(entries), [], user("SIDE"), {
      contextPipelineEnabled: false,
      maxEstimatedTokens: 700,
    });
    const text = textOf(messages);

    expect(text).toContain("context was omitted");
    expect(text).not.toContain("OLD-");
    expect(text).toContain("RECENT-");
    expect(text).toContain("SIDE");
  });

  it("places the boundary after parent history and before all side turns without mutating the session", () => {
    const entries = [
      { type: "message", id: "u", parentId: null, timestamp: "2026-01-01", message: user("PARENT TASK") },
      { type: "message", id: "a", parentId: "u", timestamp: "2026-01-01", message: assistant("PARENT ANSWER") },
    ] as SessionEntry[];
    const original = structuredClone(entries);
    const turns = [{ userMessage: user("FIRST SIDE"), assistantMessage: assistant("SIDE ANSWER") }];
    const messages = buildSideMessages(reader(entries), turns, user("FOLLOW UP"), { contextPipelineEnabled: false });

    expect(messages.map((message) => textOf([message]))).toEqual([
      "PARENT TASK", "PARENT ANSWER", SIDE_BOUNDARY_PROMPT, "FIRST SIDE", "SIDE ANSWER", "FOLLOW UP",
    ]);
    expect(messages[2].role).toBe("user");
    expect(entries).toEqual(original);
  });

  it("retains the boundary even when the budget cannot fit any history", () => {
    const messages = buildSideMessages(reader([]), [], user("SIDE"), { maxEstimatedTokens: 1 });
    expect(messages.map((message) => textOf([message]))).toEqual([SIDE_BOUNDARY_PROMPT, "SIDE"]);
  });

  it("reserves response room and provides a stricter overflow-retry budget", () => {
    const prompt = "x".repeat(4000);

    expect(sideInputBudget(272000, prompt)).toBe(272000 - 16384 - 1000);
    expect(emergencySideInputBudget(272000, prompt)).toBe(136000 - 1000);
  });
});
