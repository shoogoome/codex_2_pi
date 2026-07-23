// Panel-visibility gate + read cap + poll re-entrancy tests.
//
// These live in their own file because they `vi.mock("./diskOutput.js")` to
// spy on the exact output-read call `pollTasks` makes. framework.test.ts uses
// the real disk, so mixing the mock there would poison those cases. Vitest
// isolates the module graph per file, so the mock here does not leak.

import { afterEach, describe, expect, it, vi } from "vitest";

// Replace diskOutput with spies. framework.ts imports exactly these two named
// exports; nothing else in this file's graph (taskStore / Task) touches
// diskOutput, so the mock is safe and total.
vi.mock("./diskOutput.js", () => ({
  getTaskOutputTailDelta: vi.fn(async () => ({ content: "", newOffset: 0 })),
  evictTaskOutput: vi.fn(async () => {}),
}));

import {
  POLL_MAX_READ_BYTES,
  pollTasks,
  registerTask,
  startTaskFrameworkPolling,
  stopTaskFrameworkPolling,
} from "./framework.js";
import { getTaskOutputTailDelta, evictTaskOutput } from "./diskOutput.js";
import { createTaskStore } from "./taskStore.js";
import type { TaskStateBase } from "./Task.js";

const tailSpy = vi.mocked(getTaskOutputTailDelta);
const evictSpy = vi.mocked(evictTaskOutput);

const running = (id: string): TaskStateBase => ({
  id,
  type: "local_bash",
  status: "running",
  description: `task ${id}`,
  startTime: 0,
  outputFile: `/tmp/${id}.output`,
  outputOffset: 0,
  notified: false,
});

const terminalNotified = (id: string): TaskStateBase => ({
  ...running(id),
  status: "completed",
  notified: true,
});

afterEach(() => {
  stopTaskFrameworkPolling();
  vi.clearAllMocks();
  tailSpy.mockImplementation(async () => ({ content: "", newOffset: 0 }));
});

describe("pollTasks — panel-visibility read gate", () => {
  it("does NOT call getTaskOutputTailDelta for running tasks when panel is hidden", async () => {
    const store = createTaskStore();
    registerTask(running("brun1"), store);

    const result = await pollTasks(store, { isPanelVisible: () => false });

    expect(tailSpy).not.toHaveBeenCalled();
    expect(result.updatedTaskOffsets).toEqual({});
  });

  it("does NOT read output when no options are passed (default = hidden)", async () => {
    const store = createTaskStore();
    registerTask(running("brun1"), store);

    await pollTasks(store);

    expect(tailSpy).not.toHaveBeenCalled();
  });

  it("DOES read output (tail delta) for running tasks when panel is visible", async () => {
    const store = createTaskStore();
    registerTask(running("brun1"), store);
    tailSpy.mockResolvedValueOnce({ content: "abc", newOffset: 3 });

    const result = await pollTasks(store, { isPanelVisible: () => true });

    expect(tailSpy).toHaveBeenCalledTimes(1);
    expect(tailSpy).toHaveBeenCalledWith("brun1", 0, POLL_MAX_READ_BYTES);
    expect(result.updatedTaskOffsets.brun1).toBe(3);
    expect(store.getTask("brun1")?.outputOffset).toBe(3);
  });

  it("passes a custom maxReadBytes cap through to the tail read", async () => {
    const store = createTaskStore();
    registerTask(running("brun1"), store);

    await pollTasks(store, { isPanelVisible: () => true, maxReadBytes: 4096 });

    expect(tailSpy).toHaveBeenLastCalledWith("brun1", 0, 4096);
  });

  it("still evicts terminal+notified tasks while hidden (terminal path independent of read gate)", async () => {
    const store = createTaskStore();
    registerTask(terminalNotified("bdone1"), store);

    const result = await pollTasks(store, { isPanelVisible: () => false });

    // No output read for the (terminal) task, but eviction + disk-evict still run.
    expect(tailSpy).not.toHaveBeenCalled();
    expect(result.evictedTaskIds).toEqual(["bdone1"]);
    expect(store.getTask("bdone1")).toBeUndefined();
    expect(evictSpy).toHaveBeenCalledWith("bdone1");
  });
});

describe("startTaskFrameworkPolling — re-entrancy guard", () => {
  it("skips a tick while the previous pollTasks round is still in flight", async () => {
    vi.useFakeTimers();
    try {
      const store = createTaskStore();
      registerTask(running("brun1"), store);

      // Make the tail read hang until we release it, so the first poll round
      // stays in flight across the next timer tick.
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = () => r();
      });
      tailSpy.mockImplementation(async () => {
        await gate;
        return { content: "", newOffset: 0 };
      });

      startTaskFrameworkPolling(store, 1000, { isPanelVisible: () => true });

      // Tick #1 → pollTasks starts, awaits the gate (in flight).
      await vi.advanceTimersByTimeAsync(1000);
      expect(tailSpy).toHaveBeenCalledTimes(1);

      // Tick #2 fires while still in flight → guard skips, no new poll.
      await vi.advanceTimersByTimeAsync(1000);
      expect(tailSpy).toHaveBeenCalledTimes(1);

      // Release round #1; flush its microtasks so the in-flight flag clears.
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(tailSpy).toHaveBeenCalledTimes(1);

      // Next tick now proceeds → a fresh poll round runs.
      await vi.advanceTimersByTimeAsync(1000);
      expect(tailSpy).toHaveBeenCalledTimes(2);
    } finally {
      stopTaskFrameworkPolling();
      vi.useRealTimers();
    }
  });
});
