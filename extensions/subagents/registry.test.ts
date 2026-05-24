import { describe, expect, it, vi } from "vitest";
import { SubagentRegistry } from "./registry.js";
import type { SubagentInternalEvent } from "./types.js";

function event(summary: string): SubagentInternalEvent {
  return { kind: "response", timestamp: Date.now(), summary };
}

const options = { maxAgents: 2, maxEventLogEntries: 3, defaultWaitTimeoutMs: 30_000, minWaitTimeoutMs: 1_000, maxWaitTimeoutMs: 300_000 };

describe("SubagentRegistry", () => {
  it("creates entries and rejects duplicate task names", () => {
    const registry = new SubagentRegistry({ ...options });
    const first = registry.createEntry({ taskName: "review_api", cwd: "/repo" });

    expect(first.taskName).toBe("review_api");
    expect(first.status).toBe("starting");
    expect(() => registry.createEntry({ taskName: "review_api", cwd: "/repo" })).toThrow("subagent task_name already exists: review_api");
  });

  it("enforces max agents", () => {
    const registry = new SubagentRegistry({ ...options, maxAgents: 1 });
    registry.createEntry({ taskName: "one", cwd: "/repo" });
    expect(() => registry.createEntry({ taskName: "two", cwd: "/repo" })).toThrow("subagent limit reached: 1");
  });

  it("resolves by task name and id", () => {
    const registry = new SubagentRegistry({ ...options });
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });

    expect(registry.resolve("worker")?.id).toBe(entry.id);
    expect(registry.resolve(entry.id)?.taskName).toBe("worker");
    expect(registry.resolve("missing")).toBeUndefined();
  });

  it("truncates internal events", () => {
    const registry = new SubagentRegistry({ ...options, maxEventLogEntries: 2 });
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });

    registry.recordEvent(entry.id, event("one"));
    registry.recordEvent(entry.id, event("two"));
    registry.recordEvent(entry.id, event("three"));

    expect(registry.resolve("worker")?.events.map((item) => item.summary)).toEqual(["two", "three"]);
  });

  it("waits for mailbox updates", async () => {
    vi.useFakeTimers();
    const registry = new SubagentRegistry({ ...options });
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });

    const wait = registry.waitForUpdate(undefined, 5_000);

    registry.markRunning(entry.id);
    await vi.runOnlyPendingTimersAsync();

    await expect(wait).resolves.toMatchObject({ timedOut: false });
    vi.useRealTimers();
  });

  it("returns an already completed subagent result without waiting for another event", async () => {
    const registry = new SubagentRegistry({ ...options });
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });
    registry.markRunning(entry.id);
    registry.updateAssistantMessage(entry.id, "done");
    registry.markIdle(entry.id, "completed");

    const wait = registry.waitForUpdate(undefined, 5_000);

    await expect(wait).resolves.toMatchObject({
      timedOut: false,
      agents: [expect.objectContaining({ taskName: "worker", lastTurnStatus: "completed", lastAssistantPreview: "done" })],
    });
  });

  it("does not treat a freshly running agent as an already completed result", async () => {
    vi.useFakeTimers();
    const registry = new SubagentRegistry({ ...options });
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });
    registry.markRunning(entry.id);

    const wait = registry.waitForUpdate(undefined, 1_000);
    await expect(Promise.race([wait.then(() => "resolved"), Promise.resolve("pending")])).resolves.toBe("pending");

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(wait).resolves.toMatchObject({ timedOut: true });
    vi.useRealTimers();
  });

  it("times out waiting for updates", async () => {
    vi.useFakeTimers();
    const registry = new SubagentRegistry({ ...options });
    registry.createEntry({ taskName: "worker", cwd: "/repo" });
    const wait = registry.waitForUpdate(undefined, 1_000);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(wait).resolves.toMatchObject({ timedOut: true });
    vi.useRealTimers();
  });

  it("notifies subscribers with current summaries when entries change", () => {
    const registry = new SubagentRegistry({ ...options });
    const listener = vi.fn();

    const unsubscribe = registry.subscribe(listener);
    const entry = registry.createEntry({ taskName: "worker", cwd: "/repo" });
    registry.markRunning(entry.id);

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0][0]).toEqual([]);
    expect(listener.mock.calls[1][0]).toEqual([
      expect.objectContaining({ taskName: "worker", status: "starting" }),
    ]);
    expect(listener.mock.calls[2][0]).toEqual([
      expect.objectContaining({ taskName: "worker", status: "running" }),
    ]);

    unsubscribe();
  });

  it("stops notifying subscribers after unsubscribe", () => {
    const registry = new SubagentRegistry({ ...options });
    const listener = vi.fn();

    const unsubscribe = registry.subscribe(listener);
    unsubscribe();
    registry.createEntry({ taskName: "worker", cwd: "/repo" });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith([]);
  });
});
