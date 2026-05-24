import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "./index.js";
import type { SubagentRegistry } from "./registry.js";

describe("subagents extension running widget", () => {
  it("refreshes the below-editor widget while subagents are active", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const handlers = new Map<string, Function[]>();
    const setWidget = vi.fn();
    const closeAll = vi.fn();
    let subscribedListener: ((summaries: any[]) => void) | undefined;
    const activeSummary = {
      id: "agent_1",
      taskName: "worker",
      cwd: "/repo",
      status: "running",
      lastTurnStatus: "none",
      startedAt: 1_000,
      updatedAt: 1_000,
      usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
      eventCount: 0,
      recentEvents: [],
      mailboxVersion: 1,
    };

    const pi: any = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
    };

    const fakeRegistry = {
      subscribe: vi.fn((listener) => {
        subscribedListener = listener;
        listener([]);
        return vi.fn();
      }),
      resolve: vi.fn(),
      createEntry: vi.fn(),
      markRunning: vi.fn(),
      markFailed: vi.fn(),
      list: vi.fn(() => [activeSummary]),
      waitForUpdate: vi.fn(),
      markClosed: vi.fn(),
      closeAll,
    };

    subagentsExtension(pi, {
      registryFactory: () => fakeRegistry as unknown as SubagentRegistry,
    });

    const sessionStart = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    await sessionStart?.({ type: "session_start", reason: "startup" }, { hasUI: true, ui: { setWidget } });

    subscribedListener?.([activeSummary]);
    expect(setWidget).toHaveBeenLastCalledWith(
      "codex-subagents-running",
      ["Subagent running:", "● worker — running — 0s"],
      { placement: "belowEditor" },
    );

    await vi.advanceTimersByTimeAsync(1_000);

    expect(setWidget).toHaveBeenLastCalledWith(
      "codex-subagents-running",
      ["Subagent running:", "● worker — running — 1s"],
      { placement: "belowEditor" },
    );

    await shutdown?.({ type: "session_shutdown" }, { hasUI: true, ui: { setWidget } });
    vi.useRealTimers();
  });

  it("registers a below-editor widget on session start and clears it on shutdown", async () => {
    const handlers = new Map<string, Function[]>();
    const setWidget = vi.fn();
    const closeAll = vi.fn();

    const pi: any = {
      registerTool: vi.fn(),
      registerMessageRenderer: vi.fn(),
      on: vi.fn((event: string, handler: Function) => {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }),
    };

    const fakeRegistry = {
      subscribe: vi.fn((listener) => {
        listener([
          {
            id: "agent_1",
            taskName: "worker",
            cwd: "/repo",
            status: "running",
            lastTurnStatus: "none",
            startedAt: 1_000,
            updatedAt: 1_000,
            usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
            eventCount: 0,
            recentEvents: [],
            mailboxVersion: 1,
          },
        ]);
        return vi.fn();
      }),
      resolve: vi.fn(),
      createEntry: vi.fn(),
      markRunning: vi.fn(),
      markFailed: vi.fn(),
      list: vi.fn(() => []),
      waitForUpdate: vi.fn(),
      markClosed: vi.fn(),
      closeAll,
    };

    subagentsExtension(pi, {
      registryFactory: () => fakeRegistry as unknown as SubagentRegistry,
    });

    const sessionStart = handlers.get("session_start")?.[0];
    const shutdown = handlers.get("session_shutdown")?.[0];
    expect(sessionStart).toBeDefined();
    expect(shutdown).toBeDefined();

    await sessionStart?.({ type: "session_start", reason: "startup" }, { hasUI: true, ui: { setWidget } });

    expect(setWidget).toHaveBeenCalledWith(
      "codex-subagents-running",
      expect.arrayContaining(["Subagent running:", expect.stringContaining("worker")]),
      { placement: "belowEditor" },
    );

    await shutdown?.({ type: "session_shutdown" }, { hasUI: true, ui: { setWidget } });

    expect(setWidget).toHaveBeenLastCalledWith("codex-subagents-running", undefined, { placement: "belowEditor" });
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});
