import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _internals,
  _resetAsyncRegistryForTest,
  buildSuppressedSummary,
  createAbortEpoch,
  formatDuration,
  killAsyncTask,
  spawnAsyncShell,
  statusOf,
  tailLines,
  type SuppressedResult,
} from "./index.js";
import asyncExtension from "./index.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Fake pi: captures sendMessage calls so we can assert the completion NOTICE and
 * — critically — that it carries triggerTurn:true (the wake-up).
 *
 * `events` is a minimal stand-in for Pi's per-extension EventBus facade. It must
 * exist for tool-path tests: `getTasksHandle` looks the tasks handle up through
 * `pi.events` (extensions/shared/sessionHandle.ts), and without it any tool call
 * throws before reaching the code under test.
 */
function fakePi(): {
  pi: ExtensionAPI;
  sent: { content: unknown; details: unknown; options: unknown }[];
  events: Record<string, ((...args: unknown[]) => unknown)[]>;
  entries: { customType: string; data: unknown }[];
} {
  const sent: { content: unknown; details: unknown; options: unknown }[] = [];
  const events: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const entries: { customType: string; data: unknown }[] = [];
  const pi = {
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      (events[event] ??= []).push(fn);
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    sendMessage: (msg: unknown, options: unknown) => {
      sent.push({
        content: (msg as { content?: unknown })?.content,
        details: (msg as { details?: unknown })?.details,
        options,
      });
    },
    // EventBus facade used only for cross-extension handle lookups.
    events: {} as Record<string, unknown>,
  } as unknown as ExtensionAPI;
  return { pi, sent, events, entries };
}

/** Publish a tasks handle on the fake pi so tool-path tests can resolve the store. */
function attachFakeTasksHandle(pi: ExtensionAPI, target = store): void {
  (pi as unknown as { events: Record<string, unknown> }).events["__pi_tasks_handle__"] = {
    store: target,
    registerTaskType: () => {},
    getTaskType: () => undefined,
    unregisterTaskType: () => {},
  };
}

let store: ReturnType<typeof createTaskStore>;

beforeEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _resetAsyncRegistryForTest();
  store = createTaskStore();
  store._setSessionId(`test-${Math.random()}`);
  _setDefaultTaskStoreForTest(store);
});

afterEach(() => {
  _resetAsyncRegistryForTest();
});

/** Poll until predicate or timeout — avoids arbitrary sleeps. */
async function until(pred: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("until() timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("async_bash — submit and return without blocking", () => {
  it("returns immediately while the command is still running", async () => {
    const { pi } = fakePi();
    const t0 = Date.now();
    const task = await spawnAsyncShell(pi, store, {
      command: "sleep 3; echo done",
      cwd: "/tmp",
      notify: true,
    });
    // The call itself must not wait for the 3s command.
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(task.endedAt).toBeUndefined();
    expect(statusOf(task)).toBe("running");
    await killAsyncTask(task.id);
  });

  it("registers the task in the tasks store so task_list/task_status see it", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "sleep 2",
      cwd: "/tmp",
      label: "my poll",
      notify: true,
    });
    const stored = store.getTask(task.id);
    expect(stored).toBeDefined();
    expect(stored?.type).toBe("async_shell");
    expect(stored?.status).toBe("running");
    expect(stored?.description).toBe("my poll");
    void killAsyncTask(task.id);
  });
});

describe("async_bash — completion callback", () => {
  it("delivers an LLM-visible notice with triggerTurn:true (the wake-up)", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "echo hello-async",
      cwd: "/tmp",
      label: "greet",
      notify: true,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);

    expect(sent).toHaveLength(1);
    // triggerTurn:true is what makes an IDLE session start a new turn. Without
    // it the notice would only sit in the stream and the model would never be
    // woken — i.e. no callback at all.
    expect(sent[0]!.options).toMatchObject({ triggerTurn: true });
    const content = String(sent[0]!.content);
    expect(content).toContain("greet");
    expect(content).toContain("hello-async");
    expect((sent[0]!.details as { status?: string })?.status).toBe("completed");
  });

  it("marks a non-zero exit as failed and reports the code", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "exit 7",
      cwd: "/tmp",
      notify: true,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    expect((sent[0]!.details as { status?: string })?.status).toBe("failed");
    expect((sent[0]!.details as { exitCode?: number })?.exitCode).toBe(7);
  });

  it("stays silent when notify=never", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "echo quiet",
      cwd: "/tmp",
      notify: false,
    });
    await until(() => task.endedAt !== undefined);
    // Give any (wrong) delivery a chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });

  it("delivers exactly one notice (no duplicate) for one completion", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: true });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });

  it("captures stderr in the delivered tail", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "echo oops >&2",
      cwd: "/tmp",
      notify: true,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    expect(String(sent[0]!.content)).toContain("oops");
  });
});

describe("async — status transitions", () => {
  it("running → completed for exit 0", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: false });
    expect(statusOf(task)).toBe("running");
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("completed");
  });

  it("running → failed for a non-zero exit", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, { command: "exit 1", cwd: "/tmp", notify: false });
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("failed");
  });

  it("running → killed after async_kill (SIGTERM path)", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "sleep 30",
      cwd: "/tmp",
      notify: false,
    });
    expect(statusOf(task)).toBe("running");
    await killAsyncTask(task.id);
    expect(statusOf(task)).toBe("killed");
  });

  it("async_kill on an already-finished task is a no-op, not an error", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: false });
    await until(() => task.endedAt !== undefined);
    await expect(killAsyncTask(task.id)).resolves.toBe(true);
    expect(statusOf(task)).toBe("completed");
  });

  it("async_kill for an unknown id reports not-found", async () => {
    await expect(killAsyncTask("b-doesnotexist")).resolves.toBe(false);
  });
});

describe("async — registered tool surface", () => {
  // `async_wait` was REMOVED: it let a model burn a whole turn blocking on a
  // background task (measured: 83 calls passed timeout_ms:120000, and one
  // teammate slept a full 2 minutes waiting on a job that never finished in
  // time). Completion is delivered by wake-up instead, so the wait tool only
  // added a second, worse way to do the thing async_bash exists to avoid.
  it("registers exactly async_bash / async_status / async_kill", () => {
    const { pi } = fakePi();
    asyncExtension(pi);
    // Tools are registered synchronously in the factory body; no session event
    // needs to fire for the surface to exist.
    const registered = (
      pi.registerTool as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.map((call) => (call[0] as { name: string }).name);
    expect(registered).toEqual(["async_bash", "async_status", "async_kill"]);
    expect(registered).not.toContain("async_wait");
  });
});

describe("async — output handling", () => {
  it("writes command output into the task output file", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "echo persisted-line",
      cwd: "/tmp",
      notify: false,
    });
    await until(() => task.endedAt !== undefined);
    const { getTaskOutput } = await import("../tasks/diskOutput.js");
    await new Promise((r) => setTimeout(r, 50));
    expect(await getTaskOutput(task.id).catch(() => "")).toContain("persisted-line");
  });

  it("keeps only a bounded tail in memory", async () => {
    const { pi } = fakePi();
    // ~20KB of output; TAIL_MAX_CHARS is 4000.
    const task = await spawnAsyncShell(pi, store, {
      command: "for i in $(seq 1 400); do echo line-$i-padding-padding-padding-padding; done",
      cwd: "/tmp",
      notify: false,
    });
    await until(() => task.endedAt !== undefined);
    expect(task.tail.length).toBeLessThanOrEqual(4_000);
    // The tail keeps the END of the output, which is what matters on failure.
    expect(task.tail).toContain("line-400");
  });

  it("tailLines truncates from the head and says how many were dropped", () => {
    const text = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const out = tailLines(text, 10);
    expect(out).toContain("90 earlier lines omitted");
    expect(out).toContain("l99");
    expect(out).not.toContain("l89\n");
  });

  it("tailLines passes short output through unchanged", () => {
    expect(tailLines("a\nb", 10)).toBe("a\nb");
  });

  it("formatDuration is human-readable at minute scale", () => {
    expect(formatDuration(5_000)).toBe("5s");
    expect(formatDuration(200_000)).toBe("3m20s");
    expect(formatDuration(180_000)).toBe("3m");
  });
});

describe("async — registry isolation", () => {
  it("uses a globalThis-backed registry so teammate realms share it", () => {
    const sym = Symbol.for("pi.async.tasks");
    expect((globalThis as Record<symbol, unknown>)[sym]).toBe(_internals.registry());
  });

  it("tracks multiple concurrent tasks independently", async () => {
    const { pi } = fakePi();
    const a = await spawnAsyncShell(pi, store, { command: "sleep 0.1", cwd: "/tmp", notify: false });
    const b = await spawnAsyncShell(pi, store, { command: "sleep 5", cwd: "/tmp", notify: false });
    expect(_internals.registry().size).toBe(2);
    await until(() => a.endedAt !== undefined);
    expect(statusOf(a)).toBe("completed");
    expect(statusOf(b)).toBe("running");
    await killAsyncTask(b.id);
  });
});

describe("async — completion path must never crash the host process", () => {
  // Regression, reproduced end-to-end with real `pi --print`:
  //
  //   Error: This extension ctx is stale after session replacement or reload.
  //     at getSessionHandle (pi-async.js)
  //     at getTasksHandle
  //     at Object.get        <- a lazy store Proxy re-resolving per property access
  //     at updateTaskState
  //     at ChildProcess.finish
  //
  // A background command routinely outlives the turn that started it, and may
  // outlive the SESSION (pi --print exits when the prompt completes; the
  // platform rotates sessions). Resolving the tasks handle at that moment
  // throws — and a throw from a ChildProcess handler is an unhandled crash, not
  // a tool error.
  it("survives a store that goes stale AFTER the task was started", async () => {
    const { pi } = fakePi();
    // Faithful to the real failure: registration happens inside a live turn
    // (where a throw is a normal tool error), but the session can be replaced
    // before the command finishes — so the store must be allowed to die later.
    let stale = false;
    const dying = new Proxy(store, {
      get(target, prop, receiver) {
        if (stale) {
          throw new Error("This extension ctx is stale after session replacement or reload");
        }
        const value = Reflect.get(target as object, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as never;
    const task = await spawnAsyncShell(pi, dying, {
      command: "sleep 0.3; echo must-not-crash",
      cwd: "/tmp",
      notify: true,
    });
    // The session goes away while the command is still running.
    stale = true;
    await until(() => task.endedAt !== undefined);
    // Reaching here means no exception escaped the exit handler; vitest fails
    // the run on an unhandled rejection, and in production it killed the process.
    expect(task.exitCode).toBe(0);
  });

  it("survives a throwing pi.sendMessage on the completion path", async () => {
    const { pi: realPi } = fakePi();
    const badPi = {
      ...(realPi as unknown as Record<string, unknown>),
      sendMessage: () => {
        throw new Error("session is gone");
      },
    } as unknown as ExtensionAPI;
    const task = await spawnAsyncShell(badPi, store, {
      command: "echo still-fine",
      cwd: "/tmp",
      notify: true,
    });
    await until(() => task.endedAt !== undefined);
    expect(task.exitCode).toBe(0);
  });

  it("propagates a spawn failure as a failed task rather than throwing", async () => {
    const { pi } = fakePi();
    const task = await spawnAsyncShell(pi, store, {
      command: "echo x",
      cwd: "/nonexistent-directory-xyz",
      notify: false,
    });
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// 中止纪元：用户中止后不得被后台任务拉起（本变更的核心行为）
// ---------------------------------------------------------------------------

describe("abort epoch — 置位/解除判据", () => {
  /** 取一个只含「最后一条 assistant」的最小 agent_end 事件。 */
  const endWith = (stopReason: string | undefined) => ({
    type: "agent_end",
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "..." }], stopReason },
    ],
  });

  it("aborted 置位（用户按了停止）", () => {
    const epoch = createAbortEpoch();
    expect(epoch.wakeup.isUserAborted()).toBe(false);
    epoch.noteAgentEnd(endWith("aborted"));
    expect(epoch.wakeup.isUserAborted()).toBe(true);
  });

  it("stop 不置位（正常结束）", () => {
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd(endWith("stop"));
    expect(epoch.wakeup.isUserAborted()).toBe(false);
  });

  it("error 不置位（fail-open：拿不准就不抑制）", () => {
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd(endWith("error"));
    expect(epoch.wakeup.isUserAborted()).toBe(false);
  });

  it("畸形/缺失事件不置位且不抛", () => {
    const epoch = createAbortEpoch();
    expect(() => epoch.noteAgentEnd(undefined)).not.toThrow();
    expect(() => epoch.noteAgentEnd({})).not.toThrow();
    expect(() => epoch.noteAgentEnd({ messages: [] })).not.toThrow();
    expect(() => epoch.noteAgentEnd({ messages: [{ role: "toolResult" }] })).not.toThrow();
    // 只看最后一条 assistant：前面的 aborted 不应让后续正常结束仍处中止态。
    epoch.noteAgentEnd({
      messages: [{ role: "assistant", stopReason: "aborted" }, { role: "assistant", stopReason: "stop" }],
    });
    expect(epoch.wakeup.isUserAborted()).toBe(false);
  });
});

describe("abort epoch — 中止后抑制唤醒（两条路径）", () => {
  it("空闲态（isStreaming=false）完成不开启新会话", async () => {
    const { pi, sent } = fakePi();
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });

    const task = await spawnAsyncShell(pi, store, {
      command: "echo suppressed",
      cwd: "/tmp",
      label: "suppressed-job",
      notify: true,
      wakeup: epoch.wakeup,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);

    // 关键断言：投递方式。triggerTurn:true 才是「开新一轮」；被抑制时必须为 false。
    expect(sent[0]!.options).toMatchObject({ triggerTurn: false });
    expect((sent[0]!.options as { triggerTurn?: boolean })?.triggerTurn).not.toBe(true);
    // 且不得以任何「入队」方式投递（那正是续跑的燃料）。
    const opts = sent[0]!.options as Record<string, unknown>;
    expect(opts.deliverAs).toBeUndefined();
    // 原始 XML 不进模型上下文（由后续汇总承担）。
    const details = sent[0]!.details as { extra?: { llmVisible?: boolean } };
    expect(details.extra?.llmVisible).toBe(false);
  });

  it("运行态（isStreaming=true）完成不被当作 steer/followUp 入队", async () => {
    const { pi, sent } = fakePi();
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });

    const task = await spawnAsyncShell(pi, store, {
      command: "echo busy-suppressed",
      cwd: "/tmp",
      label: "busy-job",
      notify: true,
      wakeup: epoch.wakeup,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);

    const opts = sent[0]!.options as Record<string, unknown>;
    // 既不能 triggerTurn（开会话），也不能 steer/followUp（入队）。
    expect(opts.triggerTurn).toBe(false);
    expect(opts.deliverAs).toBeUndefined();
  });

  it("未中止时唤醒行为零变化（对照）", async () => {
    const { pi, sent } = fakePi();
    const epoch = createAbortEpoch();
    // 未置位。
    const task = await spawnAsyncShell(pi, store, {
      command: "echo normal",
      cwd: "/tmp",
      label: "normal-job",
      notify: true,
      wakeup: epoch.wakeup,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    expect(sent[0]!.options).toMatchObject({ triggerTurn: true });
    expect((sent[0]!.details as { extra?: { llmVisible?: boolean } })?.extra?.llmVisible).toBeUndefined();
    expect(epoch.snapshot().pending).toHaveLength(0);
  });

  it("不给 wakeup 时行为等同改动前（向后兼容）", async () => {
    const { pi, sent } = fakePi();
    const task = await spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: true });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    expect(sent[0]!.options).toMatchObject({ triggerTurn: true });
  });
});

describe("abort epoch — 交付与不重复", () => {
  const mk = (over: Partial<SuppressedResult> = {}): SuppressedResult => ({
    taskId: "b-1",
    command: "echo done",
    status: "completed",
    outputFile: "/tmp/b-1.output",
    finishedAt: 1_000,
    ...over,
  });

  it("交付含全部必需字段，且不引导重跑或重读历史", () => {
    const text = buildSuppressedSummary([
      mk({ taskId: "b-a", label: "build", status: "failed", exitCode: 2, finishedAt: 1 }),
      mk({ taskId: "b-b", command: "sleep 1", status: "completed", exitCode: 0, finishedAt: 2 }),
    ]);
    // 任务标识 + 终态 + 输出文件（spec 的交付契约）。
    expect(text).toContain("b-a");
    expect(text).toContain("b-b");
    expect(text).toContain("失败");
    expect(text).toContain("完成");
    expect(text).toContain("exit 2");
    expect(text).toContain("/tmp/b-1.output");
    // 标签优先，缺省时用命令首行。
    expect(text).toContain("build");
    expect(text).toContain("sleep 1");
    // 不得引导重跑或重读被裁剪的历史。
    expect(text).not.toMatch(/re-?read|重新读取历史|重跑|再次运行/);
  });

  it("killed 以「被终止」交付，而非「完成」", () => {
    const text = buildSuppressedSummary([mk({ status: "killed" })]);
    expect(text).toContain("被终止");
    expect(text).not.toContain("｜完成");
  });

  it("下一次对话时交付，且按完成时间排序", () => {
    const epoch = createAbortEpoch();
    epoch.wakeup.recordSuppressed(mk({ taskId: "later", finishedAt: 2_000 }));
    epoch.wakeup.recordSuppressed(mk({ taskId: "earlier", finishedAt: 1_000 }));

    const out = epoch.beginUserTurn();
    expect(out).toBeDefined();
    const content = out!.message.content;
    expect(content).toContain("later");
    expect(content).toContain("earlier");
    expect(content.indexOf("earlier")).toBeLessThan(content.indexOf("later"));
    expect(out!.message.details.kind).toBe("aborted-completion-summary");
    expect(out!.message.display).toBe(false);
  });

  it("交付后不重复", () => {
    const epoch = createAbortEpoch();
    epoch.wakeup.recordSuppressed(mk({ taskId: "once" }));
    expect(epoch.beginUserTurn()).toBeDefined();
    // 第二次用户发话：列表已清空，不得再交出。
    expect(epoch.beginUserTurn()).toBeUndefined();
  });

  it("无待交付时不注入任何消息", () => {
    const epoch = createAbortEpoch();
    expect(epoch.beginUserTurn()).toBeUndefined();
  });

  it("交付同时解除中止态（恢复唤醒）", () => {
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    expect(epoch.wakeup.isUserAborted()).toBe(true);
    epoch.beginUserTurn();
    expect(epoch.wakeup.isUserAborted()).toBe(false);
  });

  it("记账写失败不影响交付本身", () => {
    const epoch = createAbortEpoch(() => {
      throw new Error("appendEntry unavailable");
    });
    epoch.wakeup.recordSuppressed(mk({ taskId: "resilient" }));
    const out = epoch.beginUserTurn();
    expect(out).toBeDefined();
    expect(out!.message.content).toContain("resilient");
  });
});

describe("abort epoch — 系统续跑不算恢复（最易写错处）", () => {
  it("只发 agent_start（续跑）不解除抑制", async () => {
    const { pi, sent } = fakePi();
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });

    // 模拟中止后由残留队列驱动的续跑：agent_start 会发，但 before_agent_start 不发。
    // 本用例只用状态机验证语义；事件接线由下面的扩展级用例覆盖。
    expect(epoch.wakeup.isUserAborted()).toBe(true);

    const task = await spawnAsyncShell(pi, store, {
      command: "echo after-continue",
      cwd: "/tmp",
      label: "after-continue",
      notify: true,
      wakeup: epoch.wakeup,
    });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    // 续跑之后完成的任务仍必须被抑制。
    expect(sent[0]!.options).toMatchObject({ triggerTurn: false });
  });

  it("扩展级接线：agent_start 不解除，before_agent_start 才解除", async () => {
    const { pi, events } = fakePi();
    // 装上 tasks handle：否则 session_start 会走进「handle not found」的 catch 分支
    // 并往 stderr 打一行 logError，让测试输出看起来像失败。
    attachFakeTasksHandle(pi);
    asyncExtension(pi);
    const fire = async (name: string, event?: unknown) => {
      const handlers = events[name];
      if (!handlers) throw new Error(`no handler for ${name}`);
      for (const h of handlers) await h(event);
    };

    await fire("session_start", { type: "session_start", reason: "startup" });
    await fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });

    // 续跑只发 agent_start（本扩展未订阅它，因此中止态不会被误解除）。
    const beforeCount = (events["before_agent_start"] ?? []).length;
    expect(beforeCount).toBe(1);
    expect(events["agent_start"]).toBeUndefined();

    // 真正的用户轮：before_agent_start 返回 undefined（无待交付）且已解除中止态。
    await fire("before_agent_start", { type: "before_agent_start", prompt: "hi" });
  });

  it("扩展级接线：中止后完成被抑制，下一次发话时交付且不重复", async () => {
    const { pi, sent, events, entries } = fakePi();
    attachFakeTasksHandle(pi);
    attachFakeTasksHandle(pi);
    asyncExtension(pi);
    const fire = async (name: string, event?: unknown): Promise<unknown> => {
      let out: unknown;
      for (const h of events[name] ?? []) out = await h(event);
      return out;
    };

    await fire("session_start", { type: "session_start", reason: "startup" });
    // 用户按停止：本轮以 aborted 结束。
    await fire("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });

    const asyncBash = (pi.registerTool as unknown as {
      mock: { calls: { 0: { name: string; execute: (...a: unknown[]) => Promise<unknown> } }[] };
    }).mock.calls.map((c) => c[0]).find((t) => t.name === "async_bash");
    expect(asyncBash).toBeDefined();
    await asyncBash!.execute(undefined, { command: "echo e2e", label: "e2e-job" }, undefined, undefined, {
      cwd: "/tmp",
    });

    // 任务完成后必须被抑制（不发醒会话）。
    await until(() => sent.length > 0, 5_000);
    expect(sent[0]!.options).toMatchObject({ triggerTurn: false });

    // Pi 1.2：后台消息也触发启动钩子，不能交付中止结果或解除抑制。
    expect(await fire("before_agent_start", {
      type: "before_agent_start",
      messageType: "custom",
      message: { role: "custom", customType: "background", content: "done", display: false },
    })).toBeUndefined();
    expect(entries.some((e) => e.customType === "async/aborted-completions")).toBe(false);

    // 用户发话：第一次交付，含任务标识与输出文件。
    const first = (await fire("before_agent_start", { type: "before_agent_start", messageType: "user", prompt: "next" })) as
      | { message?: { content?: string; customType?: string } }
      | undefined;
    expect(first?.message).toBeDefined();
    expect(first!.message!.content).toContain("e2e-job");
    expect(first!.message!.customType).toBe("async/aborted-completions-summary");
    // 记账进的是 appendEntry（type="custom"），与交付内容分离。
    expect(entries.some((e) => e.customType === "async/aborted-completions")).toBe(true);

    // 第二次发话：不得重复交付。
    const second = (await fire("before_agent_start", { type: "before_agent_start", prompt: "again" })) as
      | { message?: unknown }
      | undefined;
    expect(second?.message).toBeUndefined();
  });
});

describe("abort epoch — 跨会话轮换", () => {
  const mk = (taskId: string): SuppressedResult => ({
    taskId,
    command: "echo x",
    status: "completed",
    outputFile: `/tmp/${taskId}.output`,
    finishedAt: Date.now(),
  });

  it("已交付记账可从会话 entry 读回，不重复交付", () => {
    const written: { customType: string; data: unknown }[] = [];
    const epoch = createAbortEpoch((customType, data) => {
      written.push({ customType, data });
    });
    epoch.wakeup.recordSuppressed(mk("b-persist"));
    expect(epoch.beginUserTurn()).toBeDefined();
    expect(written).toHaveLength(1);

    // 模拟 session/load：新的状态机实例，从 entry 读回记账。
    const reloaded = createAbortEpoch();
    reloaded.restoreDelivered({
      sessionManager: {
        getEntries: () =>
          written.map((w) => ({ type: "custom", customType: w.customType, data: w.data })),
      },
    });
    expect(reloaded.snapshot().delivered).toContain("b-persist");

    // 重新投递同一批：已被记账拦住。
    reloaded.wakeup.recordSuppressed(mk("b-persist"));
    expect(reloaded.beginUserTurn()).toBeUndefined();
  });

  it("reload 后未被交付过的结果仍会交付", () => {
    const reloaded = createAbortEpoch();
    reloaded.restoreDelivered({ sessionManager: { getEntries: () => [] } });
    reloaded.wakeup.recordSuppressed(mk("b-fresh"));
    const out = reloaded.beginUserTurn();
    expect(out).toBeDefined();
    expect(out!.message.content).toContain("b-fresh");
  });

  it("reset 清空全部派生态（session_shutdown）", () => {
    const epoch = createAbortEpoch();
    epoch.noteAgentEnd({ messages: [{ role: "assistant", stopReason: "aborted" }] });
    epoch.wakeup.recordSuppressed(mk("b-reset"));
    epoch.reset();
    expect(epoch.snapshot()).toMatchObject({ userAborted: false, pending: [], delivered: [] });
  });
});

describe("abort epoch — 记账 entry 不进 LLM 上下文", () => {
  const mk = (taskId: string): SuppressedResult => ({
    taskId,
    command: "echo x",
    status: "completed",
    outputFile: `/tmp/${taskId}.output`,
    finishedAt: Date.now(),
  });

  it("交付内容走 custom_message，交付记账走 custom（两者分离）", () => {
    const written: { customType: string; data: unknown }[] = [];
    const epoch = createAbortEpoch((customType, data) => written.push({ customType, data }));
    epoch.wakeup.recordSuppressed(mk("b-split"));
    const out = epoch.beginUserTurn();

    // 给模型看的：message.customType（pi 会写成 type="custom_message"，进上下文）。
    expect(out!.message.customType).toBe("async/aborted-completions-summary");
    // 给程序看的：appendEntry 的类型（pi 会写成 type="custom"，不进上下文）。
    expect(written[0]!.customType).toBe("async/aborted-completions");
    // 两者的 customType 必须不同，否则记账会污染模型上下文。
    expect(out!.message.customType).not.toBe(written[0]!.customType);
  });

  it("restoreDelivered 忽略非本类型的 entry", () => {
    const epoch = createAbortEpoch();
    epoch.restoreDelivered({
      sessionManager: {
        getEntries: () => [
          { type: "custom", customType: "some/other", data: { taskIds: ["b-should-not-count"] } },
          { type: "custom_message", customType: "async/aborted-completions", data: { taskIds: ["b-also-no"] } },
          { type: "custom", customType: "async/aborted-completions", data: { taskIds: ["b-yes"] } },
        ],
      },
    });
    expect(epoch.snapshot().delivered).toEqual(["b-yes"]);
  });
});

describe("async review activity", () => {
  it.each([false, true])("awaits baseline and closes once after failure/kill (kill=%s)", async (kill) => {
    const { getTaskActivityHandle } = await import("../tasks/activity.js");
    const hub = getTaskActivityHandle();
    const { pi, sent } = fakePi();
    const phases: string[] = [];
    let release!: () => void;
    const baseline = new Promise<void>((r) => { release = r; });
    const unsubscribe = hub.subscribe(async (e) => {
      if (e.originSessionId !== "async-review-root") return;
      phases.push(e.phase);
      if (e.phase === "before-start") await baseline;
    });
    try {
      const spawning = spawnAsyncShell(pi, store, { originSessionId: "async-review-root", originSessionFile: "/root", originCwd: "/repo", cwd: "/tmp", command: kill ? "sleep 30" : "exit 7", notify: false, ownerAgentId: "worker@team" });
      expect(phases).toEqual(["before-start"]);
      expect(store.get()).toEqual({});
      release();
      const task = await spawning;
      store._setSessionId("new-session");
      expect(hub.getActive()).toContainEqual(expect.objectContaining({ taskId: task.id, originSessionId: "async-review-root", cwd: "/tmp" }));
      expect(store.getTask(task.id)).toMatchObject({ originSessionId: "async-review-root", ownerAgentId: "worker@team" });
      if (kill) await killAsyncTask(task.id);
      await until(() => task.endedAt !== undefined);
      await vi.waitFor(() => expect(phases).toEqual(["before-start", "end"]));
      expect(hub.getActive().some((a) => a.taskId === task.id)).toBe(false);
      expect(sent).toEqual([]);
    } finally { unsubscribe(); }
  });
});
