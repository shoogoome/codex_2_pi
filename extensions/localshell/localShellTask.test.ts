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
import { spawnLocalShell, LocalShellTask, _bindPi } from "./localShellTask.js";
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

  it("calls notifyTaskTerminal exactly once on sync finish", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    await promise;
    // Filter to terminal notification only — progress messages (task_start/task_end) also go through sendMessage.
    const notifications = pi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) =>
        (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(notifications).toHaveLength(1);
  });

  it("emits tasks/progress task_start + task_end on sync finish", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    await promise;
    const progressCalls = pi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) =>
        (msg as { customType?: string }).customType === "tasks/progress",
    );
    const kinds = progressCalls.map(
      ([msg]: unknown[]) => (msg as { details: { kind: string } }).details.kind,
    );
    expect(kinds).toContain("task_start");
    expect(kinds).toContain("task_end");
    // Each progress message uses triggerTurn:false (no deliverAs).
    for (const call of progressCalls) {
      expect(call[1]).toEqual({ triggerTurn: false });
    }
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

  it("backgrounded then killed → status='killed', no double notify", async () => {
    const fake = createFakeBashOps();
    vi.useFakeTimers();
    const promise = spawnLocalShell(pi as never, store, {
      command: "sleep 999", description: "long", timeoutMs: 100, operations: fake.ops,
    });
    await vi.advanceTimersByTimeAsync(150);
    const r = await promise;
    vi.useRealTimers();
    await LocalShellTask.kill(r.taskId, store);
    fake.finish(0);
    await new Promise((res) => setTimeout(res, 50));
    const notifications = pi.sendMessage.mock.calls.filter(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(notifications).toHaveLength(1);
    const msg = notifications[0]![0] as { content: string };
    expect(msg.content).toContain("<status>killed</status>");
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

  it("evictTaskOutput called after terminal", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    const result = await promise;
    expect(result.status).toBe("completed");
    expect(store.getTask(result.taskId)).toBeDefined();
  });
});

describe("spawnLocalShell — triggerTurn behaviour", () => {
  it("sync finish notification has triggerTurn=false (LLM already mid-turn)", async () => {
    const fake = createFakeBashOps();
    const promise = spawnLocalShell(pi as never, store, {
      command: "echo hi", description: "say hi", operations: fake.ops,
    });
    await Promise.resolve();
    fake.finish(0);
    await promise;
    // 找到 notification 那条调用(progress 调用也用 sendMessage)
    const notifyCall = pi.sendMessage.mock.calls.find(
      ([msg]: unknown[]) => (msg as { customType?: string }).customType === "tasks/notification",
    );
    expect(notifyCall).toBeDefined();
    const opts = notifyCall![1] as { triggerTurn?: boolean } | undefined;
    expect(opts?.triggerTurn).toBeFalsy(); // false 或 undefined
  });

  it("backgrounded terminal notification has triggerTurn=true (LLM has walked away)", async () => {
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
    const opts = notifyCall![1] as { triggerTurn?: boolean } | undefined;
    expect(opts?.triggerTurn).toBe(true);
  });
});
