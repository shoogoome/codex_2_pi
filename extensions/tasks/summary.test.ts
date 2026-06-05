import { describe, it, expect, vi } from "vitest";
import {
  emitTaskSummary,
  installTaskSummaryContextFilter,
  registerTaskSummaryRenderer,
  TASK_SUMMARY_CUSTOM_TYPE,
  type TaskSummaryDetails,
} from "./summary.js";

const SAMPLE_TIMELINE: TaskSummaryDetails["timeline"] = [
  { kind: "task_start", summary: "general-purpose → do work", ts: 1 },
  { kind: "tool_start", summary: "grep(\"foo\")", ts: 2 },
  { kind: "tool_end", summary: "[ok] grep → 3 hits", isError: false, ts: 3 },
  { kind: "task_end", summary: "done (turns=2, tools=1)", ts: 4 },
];

function buildFakeTheme() {
  return {
    fg: (_color: string, value: string) => value,
    bg: (_color: string, value: string) => value,
    bold: (value: string) => `<b>${value}</b>`,
  };
}

describe("emitTaskSummary", () => {
  it("calls pi.sendMessage with customType=tasks/summary, triggerTurn:false", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    emitTaskSummary(pi, {
      taskId: "ax12abcd",
      taskType: "local_agent",
      status: "completed",
      description: "do work",
      agentType: "general-purpose",
      toolCallCount: 3,
      tokenCount: 12300,
      durationMs: 83000,
      timeline: SAMPLE_TIMELINE,
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = sendMessage.mock.calls[0]!;
    expect(msg.customType).toBe(TASK_SUMMARY_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(msg.details.taskId).toBe("ax12abcd");
    expect(msg.details.status).toBe("completed");
    expect(msg.details.toolCallCount).toBe(3);
    expect(msg.details.tokenCount).toBe(12300);
    expect(msg.details.durationMs).toBe(83000);
    expect(msg.details.timeline).toEqual(SAMPLE_TIMELINE);
    expect(typeof msg.details.ts).toBe("number");
    expect(opts).toEqual({ triggerTurn: false });
  });

  it("ignores throwing sendMessage (defensive try/catch)", () => {
    const sendMessage = vi.fn(() => {
      throw new Error("boom");
    });
    const pi = { sendMessage } as never;
    expect(() =>
      emitTaskSummary(pi, {
        taskId: "ax12",
        taskType: "local_agent",
        status: "failed",
        toolCallCount: 0,
        tokenCount: 0,
        durationMs: 0,
        timeline: [],
      }),
    ).not.toThrow();
  });

  it("preserves caller-provided ts when passed", () => {
    const sendMessage = vi.fn();
    const pi = { sendMessage } as never;
    emitTaskSummary(pi, {
      taskId: "ax12",
      taskType: "local_agent",
      status: "killed",
      toolCallCount: 1,
      tokenCount: 10,
      durationMs: 5,
      timeline: [],
      ts: 42,
    });
    const [msg] = sendMessage.mock.calls[0]!;
    expect(msg.details.ts).toBe(42);
  });
});

describe("registerTaskSummaryRenderer", () => {
  it("registers a renderer for the task-summary customType", () => {
    const registerMessageRenderer = vi.fn();
    const pi = { registerMessageRenderer } as never;
    registerTaskSummaryRenderer(pi);
    expect(registerMessageRenderer).toHaveBeenCalledTimes(1);
    expect(registerMessageRenderer.mock.calls[0]![0]).toBe(TASK_SUMMARY_CUSTOM_TYPE);
    expect(typeof registerMessageRenderer.mock.calls[0]![1]).toBe("function");
  });

  function captureRenderer(): (m: unknown, o: unknown, t: unknown) => unknown {
    let r: ((m: unknown, o: unknown, t: unknown) => unknown) | undefined;
    const pi = {
      registerMessageRenderer: (_t: string, fn: (m: unknown, o: unknown, t: unknown) => unknown) => {
        r = fn;
      },
    } as never;
    registerTaskSummaryRenderer(pi);
    return r!;
  }

  it("collapsed render returns single Text-like component with stats + Ctrl+O hint", () => {
    const renderer = captureRenderer();
    const details: TaskSummaryDetails = {
      taskId: "ax12",
      taskType: "local_agent",
      status: "completed",
      description: "do work",
      agentType: "general-purpose",
      toolCallCount: 12,
      tokenCount: 12300,
      durationMs: 83_000,
      timeline: SAMPLE_TIMELINE,
      ts: 1,
    };
    const out = renderer(
      { customType: TASK_SUMMARY_CUSTOM_TYPE, content: "do work", display: true, details },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(out).toBeDefined();
    const rendered = (out as { render?: (w: number) => string[] }).render?.(120) ?? [];
    const blob = rendered.join("\n");
    expect(blob).toContain("✓");
    expect(blob).toContain("general-purpose");
    expect(blob).toContain("12 tools");
    expect(blob).toContain("12.3k tokens");
    expect(blob).toContain("1m 23s");
    expect(blob).toContain("Ctrl+O");
    expect(blob).toContain(`${SAMPLE_TIMELINE.length} events`);
  });

  it("collapsed render with empty timeline shows head only (no Ctrl+O hint)", () => {
    const renderer = captureRenderer();
    const details: TaskSummaryDetails = {
      taskId: "ax12",
      taskType: "local_agent",
      status: "completed",
      agentType: "general-purpose",
      toolCallCount: 0,
      tokenCount: 0,
      durationMs: 0,
      timeline: [],
      ts: 1,
    };
    const out = renderer(
      { customType: TASK_SUMMARY_CUSTOM_TYPE, content: "x", display: true, details },
      { expanded: false },
      buildFakeTheme(),
    );
    const rendered = (out as { render?: (w: number) => string[] }).render?.(120) ?? [];
    const blob = rendered.join("\n");
    expect(blob).not.toContain("Ctrl+O");
    expect(blob).not.toContain("events");
  });

  it("expanded render returns Box-like component with timeline rows", () => {
    const renderer = captureRenderer();
    const details: TaskSummaryDetails = {
      taskId: "ax12",
      taskType: "local_agent",
      status: "completed",
      description: "do work",
      agentType: "general-purpose",
      toolCallCount: 1,
      tokenCount: 100,
      durationMs: 1000,
      timeline: SAMPLE_TIMELINE,
      ts: 1,
    };
    const out = renderer(
      { customType: TASK_SUMMARY_CUSTOM_TYPE, content: "do work", display: true, details },
      { expanded: true },
      buildFakeTheme(),
    );
    expect(out).toBeDefined();
    const rendered = (out as { render?: (w: number) => string[] }).render?.(120) ?? [];
    const blob = rendered.join("\n");
    // head must still be present
    expect(blob).toContain("general-purpose");
    // every timeline summary must appear in the expanded output
    for (const e of SAMPLE_TIMELINE) {
      expect(blob).toContain(e.summary);
    }
    // expanded should NOT contain the "Ctrl+O to expand" hint (already expanded)
    expect(blob).not.toContain("Ctrl+O");
  });

  it("uses ✗ glyph for failed status and ■ for killed", () => {
    const renderer = captureRenderer();
    const failed = renderer(
      {
        customType: TASK_SUMMARY_CUSTOM_TYPE,
        content: "boom",
        display: true,
        details: {
          taskId: "ax12",
          taskType: "local_agent",
          status: "failed",
          agentType: "general-purpose",
          toolCallCount: 0,
          tokenCount: 0,
          durationMs: 0,
          timeline: [],
          ts: 1,
        } as TaskSummaryDetails,
      },
      { expanded: false },
      buildFakeTheme(),
    );
    const failedBlob = ((failed as { render?: (w: number) => string[] }).render?.(120) ?? []).join("\n");
    expect(failedBlob).toContain("✗");

    const killed = renderer(
      {
        customType: TASK_SUMMARY_CUSTOM_TYPE,
        content: "stop",
        display: true,
        details: {
          taskId: "ax12",
          taskType: "local_agent",
          status: "killed",
          agentType: "general-purpose",
          toolCallCount: 0,
          tokenCount: 0,
          durationMs: 0,
          timeline: [],
          ts: 1,
        } as TaskSummaryDetails,
      },
      { expanded: false },
      buildFakeTheme(),
    );
    const killedBlob = ((killed as { render?: (w: number) => string[] }).render?.(120) ?? []).join("\n");
    expect(killedBlob).toContain("■");
  });

  it("renderer returns undefined when message has no details", () => {
    const renderer = captureRenderer();
    const out = renderer(
      { customType: TASK_SUMMARY_CUSTOM_TYPE, content: "no details", display: true },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(out).toBeUndefined();
  });
});

describe("installTaskSummaryContextFilter", () => {
  it("registers a context handler", () => {
    const on = vi.fn();
    const pi = { on } as never;
    installTaskSummaryContextFilter(pi);
    expect(on).toHaveBeenCalledTimes(1);
    expect(on.mock.calls[0]![0]).toBe("context");
    expect(typeof on.mock.calls[0]![1]).toBe("function");
  });

  it("filters out role=custom messages with our customType but keeps others", () => {
    let capturedHandler: ((event: unknown, ctx?: unknown) => unknown) | undefined;
    const pi = {
      on: (_event: string, handler: (e: unknown, ctx?: unknown) => unknown) => {
        capturedHandler = handler;
      },
    } as never;
    installTaskSummaryContextFilter(pi);
    const messages = [
      { role: "user", content: "hi" },
      { role: "custom", customType: TASK_SUMMARY_CUSTOM_TYPE, content: "summary" },
      { role: "assistant", content: "ok" },
      { role: "custom", customType: "tasks/notification", content: "should pass" },
    ];
    const result = capturedHandler!({ type: "context", messages });
    const filtered = (result as { messages: typeof messages }).messages;
    expect(filtered).toHaveLength(3);
    expect(filtered.map((m) => m.role)).toEqual(["user", "assistant", "custom"]);
    expect(filtered[2]).toEqual(messages[3]);
  });
});
