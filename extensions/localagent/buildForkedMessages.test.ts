import { describe, it, expect } from "vitest";
import { injectForkPlaceholders, type ForkSessionManagerLike } from "./buildForkedMessages.js";
import { FORK_PLACEHOLDER_RESULT } from "./boilerplate.js";

function makeSm(entries: unknown[]): ForkSessionManagerLike & { _appended: unknown[] } {
  const _appended: unknown[] = [];
  return {
    getEntries: () => entries,
    appendToolResultMessage: (entry) => { _appended.push(entry); },
    _appended,
  };
}

describe("injectForkPlaceholders", () => {
  it("末尾 entry 不是 assistant message → 不写任何 placeholder", () => {
    const sm = makeSm([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });

  it("末尾 assistant message 没 tool_use → 不写", () => {
    const sm = makeSm([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });

  it("末尾 assistant 含 1 个 tool_use → 写 1 个 placeholder", () => {
    const sm = makeSm([
      { role: "user", content: "fork" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "tu_abc", name: "task_agent", input: {} },
        ],
      },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(1);
    const e = sm._appended[0] as {
      role: string;
      toolCallId: string;
      toolName: string;
      content: unknown;
      isError: boolean;
      timestamp: number;
    };
    expect(e.role).toBe("toolResult");
    expect(e.toolCallId).toBe("tu_abc");
    expect(e.toolName).toBe("task_agent");
    expect(e.content).toEqual([{ type: "text", text: FORK_PLACEHOLDER_RESULT }]);
    expect(e.isError).toBe(false);
    expect(typeof e.timestamp).toBe("number");
  });

  it("末尾 assistant 含多个 tool_use → 写多个 placeholder,每个用同一 PLACEHOLDER 字符串", () => {
    const sm = makeSm([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "x", input: {} },
          { type: "tool_use", id: "tu2", name: "y", input: {} },
          { type: "tool_use", id: "tu3", name: "z", input: {} },
        ],
      },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(3);
    for (const e of sm._appended) {
      const t = e as { content: { text: string }[] };
      expect(t.content[0]!.text).toBe(FORK_PLACEHOLDER_RESULT);
    }
    const ids = sm._appended.map((e) => (e as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(["tu1", "tu2", "tu3"]);
    const names = sm._appended.map((e) => (e as { toolName: string }).toolName);
    expect(names).toEqual(["x", "y", "z"]);
  });

  it("已经有对应 toolResult 的 tool_use 不再补占位", () => {
    const sm = makeSm([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "x", input: {} },
          { type: "tool_use", id: "tu2", name: "y", input: {} },
        ],
      },
      { role: "toolResult", toolCallId: "tu1", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(1);
    expect((sm._appended[0] as { toolCallId: string }).toolCallId).toBe("tu2");
  });

  it("真实 SessionManager 包装条目与原生 toolCall 正确配对", () => {
    const sm = makeSm([
      { type: "message", message: {
        role: "assistant", content: [
          { type: "toolCall", id: "done", name: "read", arguments: {} },
          { type: "toolCall", id: "pending", name: "task_agent", arguments: {} },
        ],
      } },
      { type: "custom", customType: "metrics" },
      { type: "message", message: { role: "toolResult", toolCallId: "done", content: [] } },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([expect.objectContaining({ toolCallId: "pending", toolName: "task_agent" })]);
  });

  it("空 entries → 不写", () => {
    const sm = makeSm([]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });

  it("tool_use 没 name 字段 → toolName 为空字符串(防御性)", () => {
    const sm = makeSm([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tu1", input: {} }],
      },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(1);
    expect((sm._appended[0] as { toolName: string }).toolName).toBe("");
  });
});
