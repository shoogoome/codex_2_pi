import { describe, it, expect, vi } from "vitest";
import {
  emitTaskProgress,
  installProgressContextFilter,
  registerTaskProgressRenderer,
  TASK_PROGRESS_CUSTOM_TYPE,
  type TaskProgressDetails,
} from "./progress.js";

describe("emitTaskProgress", () => {
  it("calls pi.sendMessage with triggerTurn:false (no deliverAs)", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    emitTaskProgress(pi, {
      taskId: "ax12abcd",
      taskType: "local_agent",
      kind: "tool_start",
      summary: "grep(\"foo\")",
      toolName: "grep",
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0]!;
    expect(msg.customType).toBe(TASK_PROGRESS_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(msg.content).toBe("grep(\"foo\")");
    expect(msg.details.taskId).toBe("ax12abcd");
    expect(msg.details.kind).toBe("tool_start");
    expect(msg.details.toolName).toBe("grep");
    expect(typeof msg.details.ts).toBe("number");
    expect(opts).toEqual({ triggerTurn: false });
    expect(opts).not.toHaveProperty("deliverAs");
  });

  it("ignores throwing sendMessage (defensive try/catch)", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("boom");
    });
    const pi = { sendMessage } as never;
    expect(() =>
      emitTaskProgress(pi, {
        taskId: "ax12",
        taskType: "local_agent",
        kind: "tool_start",
        summary: "x",
      }),
    ).not.toThrow();
  });

  it("preserves caller-provided ts when passed", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    emitTaskProgress(pi, {
      taskId: "ax12",
      taskType: "local_bash",
      kind: "task_start",
      summary: "echo hi",
      ts: 42,
    });
    const [msg] = sendMessage.mock.calls[0]!;
    expect(msg.details.ts).toBe(42);
  });
});

describe("registerTaskProgressRenderer", () => {
  function buildFakeTheme() {
    return {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => value,
      bold: (value: string) => `<b>${value}</b>`,
    };
  }

  it("registers a renderer for the task-progress customType", () => {
    const registerMessageRenderer = vi.fn();
    const pi = { registerMessageRenderer } as never;
    registerTaskProgressRenderer(pi);
    expect(registerMessageRenderer).toHaveBeenCalledTimes(1);
    expect(registerMessageRenderer.mock.calls[0]![0]).toBe(TASK_PROGRESS_CUSTOM_TYPE);
    expect(typeof registerMessageRenderer.mock.calls[0]![1]).toBe("function");
  });

  it("collapsed render returns undefined — progress no longer paints to main stream", () => {
    let capturedRenderer: ((m: unknown, o: unknown, t: unknown) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: (_t: string, r: (m: unknown, o: unknown, t: unknown) => unknown) => {
        capturedRenderer = r;
      },
    } as never;
    registerTaskProgressRenderer(pi);
    const details: TaskProgressDetails = {
      taskId: "ax12",
      taskType: "local_agent",
      kind: "tool_start",
      summary: "grep(\"foo\")",
      ts: 1,
    };
    const out = capturedRenderer!(
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "grep(\"foo\")", display: true, details },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(out).toBeUndefined();
  });

  it("expanded render also returns undefined — surface lives in panel widget + summary", () => {
    let capturedRenderer: ((m: unknown, o: unknown, t: unknown) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: (_t: string, r: (m: unknown, o: unknown, t: unknown) => unknown) => {
        capturedRenderer = r;
      },
    } as never;
    registerTaskProgressRenderer(pi);
    const details: TaskProgressDetails = {
      taskId: "ax12",
      taskType: "local_agent",
      kind: "task_end",
      summary: "done (turns=2, tools=3)",
      agentType: "explore",
      toolCallCount: 3,
      tokenCount: 850,
      ts: 1,
    };
    const out = capturedRenderer!(
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "done", display: true, details },
      { expanded: true },
      buildFakeTheme(),
    );
    expect(out).toBeUndefined();
  });

  it("returns undefined even when message has no details", () => {
    let capturedRenderer: ((m: unknown, o: unknown, t: unknown) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: (_t: string, r: (m: unknown, o: unknown, t: unknown) => unknown) => {
        capturedRenderer = r;
      },
    } as never;
    registerTaskProgressRenderer(pi);
    const out = capturedRenderer!(
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "fallback", display: true },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(out).toBeUndefined();
  });
});

describe("installProgressContextFilter", () => {
  it("registers a context handler", () => {
    const on = vi.fn();
    const pi = { on } as never;
    installProgressContextFilter(pi);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe("context");
    expect(typeof on.mock.calls[0]![1]).toBe("function");
  });

  it("filters out role=custom messages with our customType", () => {
    let capturedHandler: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        capturedHandler = handler;
      },
    } as never;
    installProgressContextFilter(pi);

    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: TASK_PROGRESS_CUSTOM_TYPE, content: "[bash bx12] ▶ echo hi" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: "tasks/notification", content: "should pass through" },
    ];
    const result = capturedHandler!({ type: "context", messages });
    expect(result).toBeDefined();
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => m.role)).toEqual(["user", "assistant", "custom"]);
    // tasks/notification (different customType) survives
    expect(filtered[2]).toEqual(messages[3]);
  });

  it("returns unchanged messages when no progress entries present", () => {
    let capturedHandler: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        capturedHandler = handler;
      },
    } as never;
    installProgressContextFilter(pi);
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    const result = capturedHandler!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toEqual(messages);
  });
});
