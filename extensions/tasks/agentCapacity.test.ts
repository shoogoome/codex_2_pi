import {
  AGENT_MAX_CONCURRENT_ENV,
  AGENT_MAX_THREADS_ENV,
  createAgentCapacity,
  resolveAgentCapacityOptions,
} from "./agentCapacity.js";

describe("AgentCapacity", () => {
  it("uses Codex-style limits including one implicit leader", () => {
    const capacity = createAgentCapacity();
    expect(capacity.snapshot()).toEqual({
      maxThreads: 6,
      maxConcurrent: 4,
      residentChildren: 0,
      activeChildren: 0,
      queuedExecutions: 0,
    });

    const leases = Array.from({ length: 5 }, () => capacity.reserveResident());
    expect(() => capacity.reserveResident()).toThrow(/6 total threads including the leader/);
    leases[0]!.release();
    expect(() => capacity.reserveResident()).not.toThrow();
  });

  it("queues execution above three children and grants in FIFO order", async () => {
    const capacity = createAgentCapacity({ maxThreads: 6, maxConcurrent: 4 });
    const first = await capacity.acquireExecution();
    const second = await capacity.acquireExecution();
    const third = await capacity.acquireExecution();
    const order: string[] = [];
    const fourthPromise = capacity.acquireExecution().then((lease) => {
      order.push("fourth");
      return lease;
    });
    const fifthPromise = capacity.acquireExecution().then((lease) => {
      order.push("fifth");
      return lease;
    });

    expect(capacity.snapshot().queuedExecutions).toBe(2);
    second.release();
    const fourth = await fourthPromise;
    expect(order).toEqual(["fourth"]);
    fourth.release();
    const fifth = await fifthPromise;
    expect(order).toEqual(["fourth", "fifth"]);

    first.release();
    third.release();
    fifth.release();
    expect(capacity.snapshot().activeChildren).toBe(0);
  });

  it("removes an aborted execution waiter without consuming capacity", async () => {
    const capacity = createAgentCapacity({ maxThreads: 3, maxConcurrent: 2 });
    const active = await capacity.acquireExecution();
    const controller = new AbortController();
    const waiting = capacity.acquireExecution(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toThrow(/aborted/);
    expect(capacity.snapshot().queuedExecutions).toBe(0);
    active.release();
    expect(capacity.snapshot().activeChildren).toBe(0);
  });

  it("reset rejects waiters and invalidates old leases", async () => {
    const capacity = createAgentCapacity({ maxThreads: 3, maxConcurrent: 2 });
    const resident = capacity.reserveResident();
    const active = await capacity.acquireExecution();
    const waiting = capacity.acquireExecution();

    capacity.reset("session changed");
    await expect(waiting).rejects.toThrow("session changed");
    resident.release();
    active.release();
    expect(capacity.snapshot()).toMatchObject({
      residentChildren: 0,
      activeChildren: 0,
      queuedExecutions: 0,
    });
  });

  it("reads positive environment overrides and clamps concurrency to threads", () => {
    expect(resolveAgentCapacityOptions({
      [AGENT_MAX_THREADS_ENV]: "3",
      [AGENT_MAX_CONCURRENT_ENV]: "9",
    })).toEqual({ maxThreads: 3, maxConcurrent: 3 });
    expect(resolveAgentCapacityOptions({
      [AGENT_MAX_THREADS_ENV]: "bad",
      [AGENT_MAX_CONCURRENT_ENV]: "0",
    })).toEqual({ maxThreads: 6, maxConcurrent: 4 });
  });
});
