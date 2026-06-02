import { describe, it, expect, vi } from "vitest";
import {
  emitTaskProgress,
  registerTaskProgressRenderer,
  TASK_PROGRESS_CUSTOM_TYPE,
  type TaskProgressDetails,
} from "./progress.js";

describe("emitTaskProgress", () => {
  it("calls pi.sendMessage with triggerTurn:false + deliverAs:nextTurn", () => {
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
    expect(opts).toEqual({ triggerTurn: false, deliverAs: "nextTurn" });
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

  it("collapsed render returns a Text-like component (smoke)", () => {
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
    expect(out).toBeDefined();
  });

  it("expanded render returns a Box-like component (smoke)", () => {
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
    expect(out).toBeDefined();
  });

  it("renderer falls back to Text when message has no details", () => {
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
    expect(out).toBeDefined();
  });
});
