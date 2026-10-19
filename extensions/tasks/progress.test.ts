import { describe, it, expect, vi } from "vitest";
import {
  emitTaskProgress,
  installProgressContextFilter,
  registerTaskProgressRenderer,
  TASK_PROGRESS_CUSTOM_TYPE,
  type TaskProgressDetails,
} from "./progress.js";

describe("emitTaskProgress", () => {
  it("persists a custom entry instead of sending a custom message", () => {
    const appendEntry = vi.fn();
    const pi = { appendEntry } as never;
    emitTaskProgress(pi, {
      taskId: "ax12abcd",
      taskType: "local_agent",
      kind: "tool_start",
      summary: "grep(\"foo\")",
      toolName: "grep",
    });
    expect(appendEntry).toHaveBeenCalledTimes(1);
    const [customType, data] = appendEntry.mock.calls[0]!;
    expect(customType).toBe(TASK_PROGRESS_CUSTOM_TYPE);
    expect(data.content).toBe("grep(\"foo\")");
    expect(data.details.taskId).toBe("ax12abcd");
    expect(data.details.kind).toBe("tool_start");
    expect(data.details.toolName).toBe("grep");
    expect(typeof data.details.ts).toBe("number");
  });

  it("ignores throwing appendEntry (defensive try/catch)", () => {
    const appendEntry = vi.fn(() => {
      throw new Error("boom");
    });
    const pi = { appendEntry } as never;
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
    const appendEntry = vi.fn();
    const pi = { appendEntry } as never;
    emitTaskProgress(pi, {
      taskId: "ax12",
      taskType: "local_bash",
      kind: "task_start",
      summary: "echo hi",
      ts: 42,
    });
    const [, data] = appendEntry.mock.calls[0]!;
    expect(data.details.ts).toBe(42);
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
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "grep(\"foo\")", display: false, details },
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
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "done", display: false, details },
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
      { customType: TASK_PROGRESS_CUSTOM_TYPE, content: "fallback", display: false },
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
