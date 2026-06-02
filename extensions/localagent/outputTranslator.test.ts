import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { translateAgentEvent } from "./outputTranslator.js";

describe("translateAgentEvent", () => {
  it("tool_execution_start → '[tool] name(args)\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { file: "a.ts" } } as never,
      (s) => lines.push(s),
    );
    expect(lines).toEqual([`[tool] read({"file":"a.ts"})\n`]);
  });

  it("args 太长被截断到 80 chars + ...", () => {
    const longArg = { x: "a".repeat(200) };
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: longArg } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!.length).toBeLessThanOrEqual(120);
    expect(lines[0]!).toMatch(/\.\.\./);
  });

  it("tool_execution_end success → '[ok] name → result\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: "hi" }, isError: false } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/^\[ok\] read /);
  });

  it("tool_execution_end isError → '[err] name: ...'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: "boom", isError: true } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/^\[err\] read: boom/);
  });

  it("message_end[assistant] 写 '\\n=== FINAL ===\\n{text}\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Scope: x\nResult: y" }],
        },
      } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/=== FINAL ===/);
    expect(lines[0]!).toContain("Scope: x");
  });

  it("message_end[user] 不写", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "message_end", message: { role: "user", content: "hi" } } as never,
      (s) => lines.push(s),
    );
    expect(lines).toEqual([]);
  });

  it("agent_end → '\\n=== END (turns=N, tools=M) ===\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent({ type: "agent_end", messages: new Array(8) } as never, (s) => lines.push(s), { turnCount: 3, toolCount: 5 });
    expect(lines[0]!).toMatch(/=== END \(turns=3, tools=5\) ===/);
  });

  it("message_update / message_start / turn_start / agent_start / queue_update 不输出", () => {
    const types = [
      "message_update",
      "message_start",
      "turn_start",
      "agent_start",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "thinking_level_changed",
      "session_info_changed",
    ];
    for (const t of types) {
      const lines: string[] = [];
      translateAgentEvent({ type: t } as never, (s) => lines.push(s));
      expect(lines).toEqual([]);
    }
  });
});
