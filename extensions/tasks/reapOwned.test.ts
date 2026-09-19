import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  findOwnedRunningTasks,
  reapOwnedTasks,
} from "./reapOwned.js";
import { createTaskStore } from "./taskStore.js";
import { registerTask } from "./framework.js";
import { createTaskStateBase, type Task, type TaskStateBase } from "./Task.js";

/**
 * Regression coverage for a MEASURED leak: killing a teammate (the `k` key,
 * `task_kill`, or a team_delete cascade) left the teammate's background shell
 * children running. `async_bash` keeps its ChildProcess only in a
 * process-global registry, so nothing in the session abort/dispose path can
 * reach it.
 *
 * Observed end-to-end in one session with two teammates:
 *   - tfg's foreground `bash sleep 4321`  -> gone after kill   (correct)
 *   - tbg's `async_bash sleep 5321`       -> STILL RUNNING     (leak)
 * Both teammate session files stopped growing, proving the owners died and only
 * the children leaked. The leaked child also stayed `running` in task_list and
 * later woke the leader with a completion notice for a dead teammate.
 */

function seed(
  store: ReturnType<typeof createTaskStore>,
  id: string,
  overrides: Partial<TaskStateBase> = {},
): TaskStateBase {
  const task: TaskStateBase = {
    ...createTaskStateBase({
      id,
      type: "async_shell",
      description: `task ${id}`,
      outputFile: `/tmp/${id}.out`,
    }),
    status: "running",
    ...overrides,
  };
  registerTask(task, store);
  return task;
}

describe("findOwnedRunningTasks", () => {
  it("returns only non-terminal tasks owned by that agent", () => {
    const store = createTaskStore();
    seed(store, "mine1", { ownerAgentId: "a@t" });
    seed(store, "mine2", { ownerAgentId: "a@t", status: "completed" });
    seed(store, "theirs", { ownerAgentId: "b@t" });
    seed(store, "leaderOwned"); // no owner

    expect(findOwnedRunningTasks(store, "a@t").map((t) => t.id)).toEqual(["mine1"]);
  });

  it("never claims leader-owned tasks (no ownerAgentId)", () => {
    const store = createTaskStore();
    seed(store, "leaderOwned");
    expect(findOwnedRunningTasks(store, "a@t")).toEqual([]);
  });

  it("treats failed and killed as terminal too", () => {
    const store = createTaskStore();
    seed(store, "f", { ownerAgentId: "a@t", status: "failed" });
    seed(store, "k", { ownerAgentId: "a@t", status: "killed" });
    expect(findOwnedRunningTasks(store, "a@t")).toEqual([]);
  });
});

describe("reapOwnedTasks", () => {
  it("kills every running task owned by the agent", async () => {
    const store = createTaskStore();
    seed(store, "o1", { ownerAgentId: "a@t" });
    seed(store, "o2", { ownerAgentId: "a@t" });
    seed(store, "other", { ownerAgentId: "b@t" });

    const killed: string[] = [];
    const impl: Task = {
      name: "Fake",
      type: "async_shell",
      kill: vi.fn(async (taskId: string) => {
        killed.push(taskId);
      }),
    };

    const ids = await reapOwnedTasks(store, "a@t", "test", () => impl);

    expect(ids.sort()).toEqual(["o1", "o2"]);
    expect(killed.sort()).toEqual(["o1", "o2"]);
    // The other teammate's task must be untouched.
    expect(killed).not.toContain("other");
  });

  it("is a no-op when the agent owns nothing", async () => {
    const store = createTaskStore();
    const kill = vi.fn();
    const ids = await reapOwnedTasks(
      store,
      "ghost@t",
      "test",
      () => ({ name: "F", type: "async_shell", kill }) as Task,
    );
    expect(ids).toEqual([]);
    expect(kill).not.toHaveBeenCalled();
  });

  it("keeps going when one kill throws (terminal-path robustness)", async () => {
    const store = createTaskStore();
    seed(store, "boom", { ownerAgentId: "a@t" });
    seed(store, "ok", { ownerAgentId: "a@t" });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const killed: string[] = [];
    const ids = await reapOwnedTasks(store, "a@t", "test", () => ({
      name: "F",
      type: "async_shell",
      kill: async (taskId: string) => {
        if (taskId === "boom") throw new Error("child already gone");
        killed.push(taskId);
      },
    }) as Task);
    errorSpy.mockRestore();

    expect(killed).toEqual(["ok"]);
    expect(ids.sort()).toEqual(["boom", "ok"]);
  });

  it("reports a missing kill implementation instead of pretending success", async () => {
    const store = createTaskStore();
    seed(store, "orphan", { ownerAgentId: "a@t" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const ids = await reapOwnedTasks(store, "a@t", "test", () => undefined);
    const logged = errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
    errorSpy.mockRestore();

    expect(ids).toEqual(["orphan"]);
    expect(logged).toContain("no kill implementation");
  });
});
