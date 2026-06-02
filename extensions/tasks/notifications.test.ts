import { describe, expect, it, vi } from "vitest";
import {
  buildTaskNotificationXml,
  markTaskNotified,
  notifyTaskTerminal,
  registerTaskNotificationRenderer,
  TASK_NOTIFICATION_CUSTOM_TYPE,
  type NotifyTaskTerminalOptions,
  type TaskNotificationDetails,
} from "./notifications.js";
import { createTaskStore } from "./taskStore.js";
import { registerTask, PANEL_GRACE_MS } from "./framework.js";
import type { TaskStateBase } from "./Task.js";
import { escapeXml } from "./xmlTags.js";

const sample = (id: string, overrides: Partial<TaskStateBase> = {}): TaskStateBase => ({
  id,
  type: "local_bash",
  status: "running",
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
  ...overrides,
});

const baseOpts = (overrides: Partial<NotifyTaskTerminalOptions> = {}): NotifyTaskTerminalOptions => ({
  taskId: "babcdefgh",
  taskType: "local_bash",
  status: "completed",
  description: "echo hi",
  outputFile: "/tmp/babcdefgh.output",
  ...overrides,
});

describe("escapeXml", () => {
  it("escapes the five XML special chars", () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&apos;f");
  });
});

describe("markTaskNotified", () => {
  it("returns true on first flip and updates store", () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    expect(markTaskNotified("babcdefgh", store)).toBe(true);
    expect(store.getTask("babcdefgh")?.notified).toBe(true);
  });

  it("returns false on subsequent calls (already notified)", () => {
    const store = createTaskStore();
    registerTask({ ...sample("babcdefgh"), notified: true }, store);
    expect(markTaskNotified("babcdefgh", store)).toBe(false);
  });

  it("returns false for non-existent task without throwing", () => {
    const store = createTaskStore();
    expect(markTaskNotified("nope", store)).toBe(false);
  });

  it("sets retain=true + evictAfter on the task when flipping notified", () => {
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    const before = Date.now();
    markTaskNotified("babcdefgh", store);
    const t = store.getTask("babcdefgh") as { notified: boolean; retain?: boolean; evictAfter?: number };
    expect(t.notified).toBe(true);
    expect(t.retain).toBe(true);
    expect(t.evictAfter).toBeGreaterThanOrEqual(before + PANEL_GRACE_MS - 100);
    expect(t.evictAfter).toBeLessThanOrEqual(Date.now() + PANEL_GRACE_MS + 100);
  });

  it("second markTaskNotified does NOT update evictAfter (already-notified short-circuit)", () => {
    const store = createTaskStore();
    registerTask({ ...sample("babcdefgh"), notified: true } as never, store);
    const beforeT = store.getTask("babcdefgh") as { evictAfter?: number };
    const beforeEvictAfter = beforeT.evictAfter;
    markTaskNotified("babcdefgh", store);
    const afterT = store.getTask("babcdefgh") as { evictAfter?: number };
    expect(afterT.evictAfter).toBe(beforeEvictAfter);
  });
});

describe("buildTaskNotificationXml", () => {
  it("includes mandatory tags", () => {
    const xml = buildTaskNotificationXml(baseOpts());
    expect(xml).toContain("<task_notification>");
    expect(xml).toContain("<task_id>babcdefgh</task_id>");
    expect(xml).toContain("<task_type>local_bash</task_type>");
    expect(xml).toContain("<output_file>/tmp/babcdefgh.output</output_file>");
    expect(xml).toContain("<status>completed</status>");
    expect(xml).toContain("<summary>echo hi completed successfully</summary>");
    expect(xml).toContain("</task_notification>");
  });

  it("uses correct status text per status", () => {
    expect(buildTaskNotificationXml(baseOpts({ status: "failed" }))).toContain(
      "<summary>echo hi failed</summary>",
    );
    expect(buildTaskNotificationXml(baseOpts({ status: "killed" }))).toContain(
      "<summary>echo hi was stopped</summary>",
    );
  });

  it("includes optional tool_use_id when provided", () => {
    expect(buildTaskNotificationXml(baseOpts({ toolUseId: "tool_use_42" }))).toContain(
      "<tool_use_id>tool_use_42</tool_use_id>",
    );
  });

  it("omits tool_use_id when not provided", () => {
    expect(buildTaskNotificationXml(baseOpts())).not.toContain("<tool_use_id>");
  });

  it("includes exit_code when provided", () => {
    expect(buildTaskNotificationXml(baseOpts({ exitCode: 1 }))).toContain(
      "<exit_code>1</exit_code>",
    );
  });

  it("omits exit_code when not provided", () => {
    expect(buildTaskNotificationXml(baseOpts())).not.toContain("<exit_code>");
  });

  it("includes worktree block with branch when both provided", () => {
    const xml = buildTaskNotificationXml(
      baseOpts({ worktreePath: "/wt/path", worktreeBranch: "feat/x" }),
    );
    expect(xml).toContain("<worktree>");
    expect(xml).toContain("<path>/wt/path</path>");
    expect(xml).toContain("<branch>feat/x</branch>");
  });

  it("omits worktree block when not provided", () => {
    expect(buildTaskNotificationXml(baseOpts())).not.toContain("<worktree>");
  });

  it("custom summary overrides default template", () => {
    expect(buildTaskNotificationXml(baseOpts({ summary: "All good" }))).toContain(
      "<summary>All good</summary>",
    );
    expect(buildTaskNotificationXml(baseOpts({ summary: "All good" }))).not.toContain(
      "completed successfully",
    );
  });

  it("escapes XML special chars in description", () => {
    const xml = buildTaskNotificationXml(baseOpts({ description: `a<b>"c'&d` }));
    expect(xml).toContain("a&lt;b&gt;&quot;c&apos;&amp;d");
  });
});

describe("notifyTaskTerminal", () => {
  function createFakePi() {
    return {
      sendMessage: vi.fn(),
      registerMessageRenderer: vi.fn(),
    } as unknown as Parameters<typeof notifyTaskTerminal>[0] & {
      sendMessage: ReturnType<typeof vi.fn>;
      registerMessageRenderer: ReturnType<typeof vi.fn>;
    };
  }

  it("default options produce immediate-render: no triggerTurn, no deliverAs", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    notifyTaskTerminal(pi, store, baseOpts());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [msg, opts] = pi.sendMessage.mock.calls[0]!;
    expect(msg.customType).toBe(TASK_NOTIFICATION_CUSTOM_TYPE);
    expect(msg.display).toBe(true);
    expect(typeof msg.content).toBe("string");
    expect(msg.content).toContain("<task_notification>");
    const details = msg.details as TaskNotificationDetails;
    expect(details.taskId).toBe("babcdefgh");
    expect(details.status).toBe("completed");
    expect(details.timestamp).toBeGreaterThan(0);
    expect(opts).toEqual({});  // deliverAs 和 triggerTurn 都是 undefined — 立即渲染
  });

  it("second call is a silent no-op (CAS guard)", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    notifyTaskTerminal(pi, store, baseOpts());
    notifyTaskTerminal(pi, store, baseOpts());
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("triggerTurn / deliverAs override defaults", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    notifyTaskTerminal(pi, store, baseOpts({ triggerTurn: true, deliverAs: "steer" }));
    expect(pi.sendMessage.mock.calls[0]![1]).toEqual({
      triggerTurn: true,
      deliverAs: "steer",
    });
  });

  it("does NOT send when task not in store (CAS returns false)", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    notifyTaskTerminal(pi, store, baseOpts());
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("respects custom summary override", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    notifyTaskTerminal(pi, store, baseOpts({ summary: "Build done" }));
    expect(pi.sendMessage.mock.calls[0]![0].content).toContain("<summary>Build done</summary>");
  });

  it("propagates extra into details", () => {
    const pi = createFakePi();
    const store = createTaskStore();
    registerTask(sample("babcdefgh"), store);
    notifyTaskTerminal(pi, store, baseOpts({ extra: { reviewProgress: { found: 3 } } }));
    const details = pi.sendMessage.mock.calls[0]![0].details as TaskNotificationDetails;
    expect(details.extra).toEqual({ reviewProgress: { found: 3 } });
  });
});

describe("registerTaskNotificationRenderer", () => {
  function buildFakeTheme() {
    return {
      fg: (_color: string, value: string) => value,
      bg: (_color: string, value: string) => value,
      bold: (value: string) => `<b>${value}</b>`,
    };
  }

  it("registers a renderer for the task-notification customType", () => {
    const pi = {
      registerMessageRenderer: vi.fn(),
    } as unknown as Parameters<typeof registerTaskNotificationRenderer>[0] & {
      registerMessageRenderer: ReturnType<typeof vi.fn>;
    };
    registerTaskNotificationRenderer(pi);
    expect(pi.registerMessageRenderer).toHaveBeenCalledTimes(1);
    expect(pi.registerMessageRenderer.mock.calls[0]![0]).toBe(TASK_NOTIFICATION_CUSTOM_TYPE);
  });

  it("collapsed render produces a single Text-like component (smoke test)", () => {
    const pi = {
      registerMessageRenderer: vi.fn(),
    } as unknown as Parameters<typeof registerTaskNotificationRenderer>[0] & {
      registerMessageRenderer: ReturnType<typeof vi.fn>;
    };
    registerTaskNotificationRenderer(pi);
    const renderer = pi.registerMessageRenderer.mock.calls[0]![1] as (
      m: { content: string; details: TaskNotificationDetails | undefined },
      o: { expanded: boolean },
      t: ReturnType<typeof buildFakeTheme>,
    ) => unknown;
    const result = renderer(
      {
        content: "<task_notification></task_notification>",
        details: {
          taskId: "b1",
          taskType: "local_bash",
          status: "completed",
          description: "echo hi",
          outputFile: "/tmp/b1.output",
          timestamp: 0,
        },
      },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(result).toBeDefined();
  });

  it("expanded render produces a Box with multiple children (smoke test)", () => {
    const pi = {
      registerMessageRenderer: vi.fn(),
    } as unknown as Parameters<typeof registerTaskNotificationRenderer>[0] & {
      registerMessageRenderer: ReturnType<typeof vi.fn>;
    };
    registerTaskNotificationRenderer(pi);
    const renderer = pi.registerMessageRenderer.mock.calls[0]![1] as (
      m: { content: string; details: TaskNotificationDetails | undefined },
      o: { expanded: boolean },
      t: ReturnType<typeof buildFakeTheme>,
    ) => unknown;
    const result = renderer(
      {
        content: "<task_notification></task_notification>",
        details: {
          taskId: "b1",
          taskType: "local_bash",
          status: "completed",
          description: "echo hi",
          outputFile: "/tmp/b1.output",
          worktreePath: "/wt",
          worktreeBranch: "feat",
          finalMessage: "all good",
          timestamp: 0,
        },
      },
      { expanded: true },
      buildFakeTheme(),
    );
    expect(result).toBeDefined();
  });

  it("renders without details (raw fallback)", () => {
    const pi = {
      registerMessageRenderer: vi.fn(),
    } as unknown as Parameters<typeof registerTaskNotificationRenderer>[0] & {
      registerMessageRenderer: ReturnType<typeof vi.fn>;
    };
    registerTaskNotificationRenderer(pi);
    const renderer = pi.registerMessageRenderer.mock.calls[0]![1] as (
      m: { content: string; details: TaskNotificationDetails | undefined },
      o: { expanded: boolean },
      t: ReturnType<typeof buildFakeTheme>,
    ) => unknown;
    const result = renderer(
      { content: "raw content", details: undefined },
      { expanded: false },
      buildFakeTheme(),
    );
    expect(result).toBeDefined();
  });
});
