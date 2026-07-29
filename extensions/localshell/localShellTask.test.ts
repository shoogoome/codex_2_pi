import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _clearOutputsForTest,
} from "../tasks/diskOutput.js";
import {
  _resetTaskOutputDirForTest,
} from "../tasks/outputPath.js";
import {
  createTaskStore,
  type TaskStore,
} from "../tasks/taskStore.js";
import {
  spawnLocalShell,
  LocalShellTask,
  _bindPi,
  _setLocalShellAgentStreaming,
} from "./localShellTask.js";
import { createFakeBashOps } from "./_test/fakeBashOperations.js";
import { _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";

let tmpRoot: string;
let originalTmpdirEnv: string | undefined;
let store: TaskStore;
let pi: { sendMessage: ReturnType<typeof vi.fn> };

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "spawn-test-"));
  originalTmpdirEnv = process.env.TMPDIR;
  process.env.TMPDIR = tmpRoot;
  store = createTaskStore();
  store._setSessionId(`spawn-${Math.random().toString(36).slice(2)}`);
  _setDefaultTaskStoreForTest(store);
  pi = { sendMessage: vi.fn() };
  _bindPi(pi as never);
});

afterEach(async () => {
  await _clearOutputsForTest();
  _resetTaskOutputDirForTest();
  _setDefaultTaskStoreForTest(undefined);
  if (originalTmpdirEnv === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdirEnv;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  vi.useRealTimers();
});

describe("spawnLocalShell — sync finish path", () => {
  it("registers task in store with status='running'", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const tasks = Object.values(store.get());
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe("running");
    fake.finish(0);
    await p;
  });

  it("initTaskOutput creates outputFile entry (latch held)", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0]!;
    expect(t.outputFile).toContain(t.id);
    fake.finish(0);
    await p;
  });

  it("starts stall watchdog (cancel function stored on state)", async () => {
    const fake = createFakeBashOps();
    const p = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0] as { cancelStallWatchdog?: () => void };
    expect(typeof t.cancelStallWatchdog).toBe("function");
    fake.finish(0);
    await p;
  });

  it("exitCode=0 → status='completed', backgrounded=false, exitCode=0", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("hello\n"));
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(result.backgrounded).toBe(false);
    expect(result.exitCode).toBe(0);
  });

  it("exitCode=1 → status='failed'", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "false", description: "fail", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(1);
    const result = await promise;
    expect(result.status).toBe("failed");
  });

  it("exitCode=null → status='killed'", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 99", description: "sig", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(null);
    const result = await promise;
    expect(result.status).toBe("killed");
  });

  it("sync finish emits no task notification/progress and unregisters foreground state", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const taskId = Object.keys(store.get())[0]!;
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(pi.sendMessage).not.toHaveBeenCalled();
    expect(store.getTask(taskId)).toBeUndefined();
  });

  it("calls onStart synchronously before silent commands emit output", async () => {
    const fake = createFakeBashOps();
    const onStart = vi.fn();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999",
      description: "silent",
      operations: fake.ops,
      onStart,
    });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(onStart).toHaveBeenCalledWith(Object.keys(store.get())[0]);
    fake.finish(0);
    await promise;
  });

  it("bounds the in-memory progress snapshot while full output remains on disk", async () => {
    const fake = createFakeBashOps();
    const onProgress = vi.fn();
    const promise = spawnLocalShell(pi as never, store, {
      command: "yes",
      description: "firehose",
      operations: fake.ops,
      onProgress,
    });
    fake.emit(Buffer.from("A".repeat(40_000)));
    fake.finish(0);
    const result = await promise;
    const last = onProgress.mock.calls.at(-1)?.[0] as { cumulative: string };
    expect(last.cumulative).toContain("bytes of earlier output omitted");
    expect(last.cumulative.length).toBeLessThan(31_000);
    expect(result.output).toContain("of earlier output omitted");
  });

  it("output is truncated to 30000 bytes (head + truncated marker + tail)", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "yes", description: "big", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("A".repeat(50_000)));
    fake.finish(0);
    const result = await promise;
    expect(result.output.length).toBeLessThan(31_000);
    expect(result.output).toContain("of earlier output omitted");
  });
});

describe("spawnLocalShell — timeout path", () => {
  it("timeoutMs hit while exec slow → resolve with backgrounded=true / status='running'", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999",
      description: "long",
      timeoutMs: 100,
      operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    const result = await promise;
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
    expect(result.backgroundReason).toBe("timeout");
    fake.finish(0);  // 让 exec promise 收尾,清理 dangling promise
  });

  it("after backgrounding, exec finishing fires terminal notify", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    await promise;
    // 转后台后还没真完成,不发终态(progress task_start 已发,过滤掉只看 notification)
    const notificationsBeforeFinish = pi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(notificationsBeforeFinish).toHaveLength(0);
    vi.useRealTimers();
    fake.finish(0);
    await new Promise((r) => setTimeout(r, 50));
    const notificationsAfterFinish = pi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(notificationsAfterFinish).toHaveLength(1);
  });

  it("backgrounded then killed → caller result is sufficient, no duplicate notification", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    const r = await promise;
    vi.useRealTimers();
    await LocalShellTask.kill(r.taskId, store);
    expect(store.getTask(r.taskId)?.status).toBe("killed");
    fake.finish(0);
    await new Promise((res) => setTimeout(res, 50));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });
});

describe("spawnLocalShell — error path", () => {
  it("multiple onData chunks all written to disk output", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("a"));
    fake.emit(Buffer.from("b"));
    fake.emit(Buffer.from("c"));
    fake.finish(0);
    const result = await promise;
    expect(result.output).toContain("abc");
  });

  it("operations.exec rejects (spawn fail) → status='failed', output contains error", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "bad", description: "err", operations: fake.ops,
    });
    await Promise.resolve();
    fake.fail(new Error("spawn ENOENT"));
    const result = await promise;
    expect(result.status).toBe("failed");
    expect(result.output).toContain("spawn ENOENT");
  });

  it("flush awaited before status flips to terminal (last chunk preserved)", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.emit(Buffer.from("LASTCHUNK"));
    fake.finish(0);
    const result = await promise;
    expect(result.output).toContain("LASTCHUNK");
  });

  it("watchdog cancelled when terminal", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    const t = Object.values(store.get())[0] as { cancelStallWatchdog?: () => void };
    const cancelled = vi.fn();
    if (t.cancelStallWatchdog) {
      const orig = t.cancelStallWatchdog;
      t.cancelStallWatchdog = () => {
        cancelled();
        orig();
      };
    }
    fake.finish(0);
    await promise;
    expect(cancelled).toHaveBeenCalled();
  });

  it("foreground task is unregistered after terminal", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(store.getTask(result.taskId)).toBeUndefined();
  });
});

describe("spawnLocalShell — background notification delivery", () => {
  it("sync finish has no notification at all", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    fake.finish(0);
    await promise;
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("default background completion updates TUI immediately but neither wakes nor enters LLM context", async () => {
    const prev = process.env.PI_TASKS_WAKE_ON_BACKGROUND;
    delete process.env.PI_TASKS_WAKE_ON_BACKGROUND;
    try {
      const fake = createFakeBashOps();
      vi.useFakeTimers();
      const promise = spawnLocalShell(pi as never, store, {
        command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
      });
      await vi.advanceTimersByTimeAsync(150);
      const backgrounded = await promise;
      vi.useRealTimers();
      fake.finish(0);
      await new Promise((r) => setTimeout(r, 50));

      const notifyCall = pi.sendMessage.mock.calls.find(
        ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
      );
      expect(notifyCall).toBeDefined();
      expect((notifyCall![0] as { display?: boolean }).display).toBe(true);
      expect((notifyCall![1] as { triggerTurn?: boolean }).triggerTurn).toBe(false);
      const details = notifyCall![0].details as { extra?: { llmVisible?: boolean } };
      expect(details.extra?.llmVisible).toBe(false);

      // Codex keeps background terminals queryable; the no-wake path retains
      // terminal metadata for five minutes instead of the generic 30s grace.
      const task = store.getTask(backgrounded.taskId) as { evictAfter?: number };
      expect(task.evictAfter! - Date.now()).toBeGreaterThan(4 * 60_000);
    } finally {
      if (prev === undefined) delete process.env.PI_TASKS_WAKE_ON_BACKGROUND;
      else process.env.PI_TASKS_WAKE_ON_BACKGROUND = prev;
    }
  });

  it("defers a no-wake completion during streaming, then flushes it at agent_end", async () => {
    const prev = process.env.PI_TASKS_WAKE_ON_BACKGROUND;
    delete process.env.PI_TASKS_WAKE_ON_BACKGROUND;
    try {
      _setLocalShellAgentStreaming(true);
      const fake = createFakeBashOps();
      vi.useFakeTimers();
      const promise = spawnLocalShell(pi as never, store, {
        command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
      });
      await vi.advanceTimersByTimeAsync(150);
      await promise;
      vi.useRealTimers();
      fake.finish(0);
      await new Promise((r) => setTimeout(r, 50));
      expect(pi.sendMessage).not.toHaveBeenCalled();

      _setLocalShellAgentStreaming(false);
      expect(pi.sendMessage).toHaveBeenCalledTimes(1);
      expect((pi.sendMessage.mock.calls[0]![1] as { triggerTurn?: boolean }).triggerTurn).toBe(
        false,
      );
    } finally {
      _setLocalShellAgentStreaming(false);
      if (prev === undefined) delete process.env.PI_TASKS_WAKE_ON_BACKGROUND;
      else process.env.PI_TASKS_WAKE_ON_BACKGROUND = prev;
    }
  });

  it("PI_TASKS_WAKE_ON_BACKGROUND=1 restores Claude-style LLM wakeup", async () => {
    const prev = process.env.PI_TASKS_WAKE_ON_BACKGROUND;
    process.env.PI_TASKS_WAKE_ON_BACKGROUND = "1";
    try {
      const fake = createFakeBashOps();
      vi.useFakeTimers();
      const promise = spawnLocalShell(pi as never, store, {
        command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
      });
      await vi.advanceTimersByTimeAsync(150);
      await promise;
      vi.useRealTimers();
      fake.finish(0);
      await new Promise((r) => setTimeout(r, 50));
      const notifyCall = pi.sendMessage.mock.calls.find(
        ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
      );
      expect(notifyCall).toBeDefined();
      expect((notifyCall![1] as { triggerTurn?: boolean }).triggerTurn).toBe(true);
      expect((notifyCall![0] as { display?: boolean }).display).toBe(true);
      const details = notifyCall![0].details as { extra?: { llmVisible?: boolean } };
      expect(details.extra?.llmVisible).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.PI_TASKS_WAKE_ON_BACKGROUND;
      else process.env.PI_TASKS_WAKE_ON_BACKGROUND = prev;
    }
  });
});

describe("spawnLocalShell — PI_TASK_BASH_TIMEOUT_MS", () => {
  it("env overrides the default 60s sync timeout", async () => {
    const prev = process.env.PI_TASK_BASH_TIMEOUT_MS;
    process.env.PI_TASK_BASH_TIMEOUT_MS = "100";
    try {
      const fake = createFakeBashOps();
      vi.useFakeTimers();
      // 不传 timeoutMs — 应读 env 的 100ms 而不是默认 60s
      const promise = spawnLocalShell(pi as never, store, {
        command: "sleep 999", description: "long", operations: fake.ops,
      });
      await vi.advanceTimersByTimeAsync(150);
      const result = await promise;
      expect(result.backgrounded).toBe(true);
      expect(result.backgroundReason).toBe("timeout");
      fake.finish(0);
    } finally {
      if (prev === undefined) delete process.env.PI_TASK_BASH_TIMEOUT_MS;
      else process.env.PI_TASK_BASH_TIMEOUT_MS = prev;
    }
  });

  it("invalid env value falls back to 60s default", async () => {
    const prev = process.env.PI_TASK_BASH_TIMEOUT_MS;
    process.env.PI_TASK_BASH_TIMEOUT_MS = "not-a-number";
    try {
      const fake = createFakeBashOps();
      vi.useFakeTimers();
      const promise = spawnLocalShell(pi as never, store, {
        command: "sleep 999", description: "long", operations: fake.ops,
      });
      // 无效 env → 默认 60s,150ms 时不应后台化
      await vi.advanceTimersByTimeAsync(150);
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      fake.finish(0);
      await promise;
    } finally {
      if (prev === undefined) delete process.env.PI_TASK_BASH_TIMEOUT_MS;
      else process.env.PI_TASK_BASH_TIMEOUT_MS = prev;
    }
  });
});
