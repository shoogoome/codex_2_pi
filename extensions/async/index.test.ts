import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _internals,
  _resetAsyncRegistryForTest,
  formatDuration,
  killAsyncTask,
  spawnAsyncShell,
  statusOf,
  tailLines,
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
 */
function fakePi(): {
  pi: ExtensionAPI;
  sent: { content: unknown; details: unknown; options: unknown }[];
  events: Record<string, ((...args: unknown[]) => unknown)[]>;
} {
  const sent: { content: unknown; details: unknown; options: unknown }[] = [];
  const events: Record<string, ((...args: unknown[]) => unknown)[]> = {};
  const pi = {
    on: (event: string, fn: (...args: unknown[]) => unknown) => {
      (events[event] ??= []).push(fn);
    },
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    appendEntry: vi.fn(),
    sendMessage: (msg: unknown, options: unknown) => {
      sent.push({
        content: (msg as { content?: unknown })?.content,
        details: (msg as { details?: unknown })?.details,
        options,
      });
    },
  } as unknown as ExtensionAPI;
  return { pi, sent, events };
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
    const task = spawnAsyncShell(pi, store, {
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

  it("registers the task in the tasks store so task_list/task_status see it", () => {
    const { pi } = fakePi();
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: true });
    await until(() => task.endedAt !== undefined);
    await until(() => sent.length > 0, 3_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(1);
  });

  it("captures stderr in the delivered tail", async () => {
    const { pi, sent } = fakePi();
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: false });
    expect(statusOf(task)).toBe("running");
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("completed");
  });

  it("running → failed for a non-zero exit", async () => {
    const { pi } = fakePi();
    const task = spawnAsyncShell(pi, store, { command: "exit 1", cwd: "/tmp", notify: false });
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("failed");
  });

  it("running → killed after async_kill (SIGTERM path)", async () => {
    const { pi } = fakePi();
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, { command: "true", cwd: "/tmp", notify: false });
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
    const task = spawnAsyncShell(pi, store, {
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
    const task = spawnAsyncShell(pi, store, {
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
    const a = spawnAsyncShell(pi, store, { command: "sleep 0.1", cwd: "/tmp", notify: false });
    const b = spawnAsyncShell(pi, store, { command: "sleep 5", cwd: "/tmp", notify: false });
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
    const task = spawnAsyncShell(pi, dying, {
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
    const task = spawnAsyncShell(badPi, store, {
      command: "echo still-fine",
      cwd: "/tmp",
      notify: true,
    });
    await until(() => task.endedAt !== undefined);
    expect(task.exitCode).toBe(0);
  });

  it("propagates a spawn failure as a failed task rather than throwing", async () => {
    const { pi } = fakePi();
    const task = spawnAsyncShell(pi, store, {
      command: "echo x",
      cwd: "/nonexistent-directory-xyz",
      notify: false,
    });
    await until(() => task.endedAt !== undefined);
    expect(statusOf(task)).toBe("failed");
  });
});
