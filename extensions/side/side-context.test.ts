import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, Message, UserMessage } from "@earendil-works/pi-ai";
import { buildSideMessages, sideInputBudget, type SideSessionReader } from "./side-context.js";

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
    expect(text.length).toBeLessThan(500);
    expect(text).toContain("what happened?");
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
      maxEstimatedTokens: 300,
    });
    const text = textOf(messages);

    expect(text).toContain("context was omitted");
    expect(text).not.toContain("OLD-");
    expect(text).toContain("RECENT-");
    expect(text).toContain("SIDE");
  });

  it("reserves response room from the model context window", () => {
    const budget = sideInputBudget(272000, "x".repeat(4000));

    expect(budget).toBe(272000 - 16384 - 1000);
  });
});
