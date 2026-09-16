import { describe, it, expect, vi, beforeEach } from "vitest";
import localagentExtension from "./index.js";

const fakeHandle = {
  store: { get: () => ({}), getTask: () => undefined } as any,
  registerTaskType: vi.fn(),
  getTaskType: vi.fn(),
  unregisterTaskType: vi.fn(),
};

const fakePi: any = {
  events: { __pi_tasks_handle__: fakeHandle },
  on: vi.fn(),
  registerTool: vi.fn(),
  registerFlag: vi.fn(),
  getActiveTools: vi.fn(() => ["read", "bash", "task_agent"]),
  setActiveTools: vi.fn(),
  sendMessage: vi.fn(),
};

beforeEach(() => {
  fakePi.on.mockClear();
  fakePi.registerTool.mockClear();
  fakeHandle.registerTaskType.mockClear();
  fakeHandle.unregisterTaskType.mockClear();
});

describe("localagent extension", () => {
  it("绑两个事件 hooks", () => {
    localagentExtension(fakePi);
    const events = fakePi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });

  it("session_start 调 registerTaskType('local_agent', LocalAgentTask) + registerTool('task_agent')", async () => {
    localagentExtension(fakePi);
    const startHandler = fakePi.on.mock.calls.find((c: any[]) => c[0] === "session_start")![1];
    await startHandler({}, { cwd: "/tmp", sessionManager: { getSessionFile: () => undefined } });
    expect(fakeHandle.registerTaskType).toHaveBeenCalledWith("local_agent", expect.objectContaining({ name: "LocalAgentTask" }));
    expect(fakePi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "task_agent" }));
  });

  it("session_shutdown 调 unregisterTaskType('local_agent')", async () => {
    localagentExtension(fakePi);
    const shutdownHandler = fakePi.on.mock.calls.find((c: any[]) => c[0] === "session_shutdown")![1];
    await shutdownHandler();
    expect(fakeHandle.unregisterTaskType).toHaveBeenCalledWith("local_agent");
  });

  it("tasks handle 缺失时仍注册 task_agent", async () => {
    // Regression: getTasksHandle used to run BEFORE registerTool, so a session
    // without the tasks handle silently lost task_agent entirely — observed in
    // a real session that kept factory-level teammate tools but had no
    // task_agent and no team_create.
    const pi: any = { ...fakePi, events: {}, registerTool: vi.fn() };
    localagentExtension(pi);
    const startHandler = pi.on.mock.calls.find((c: any[]) => c[0] === "session_start")![1];

    await startHandler({}, { cwd: "/tmp", sessionManager: { getSessionFile: () => undefined } });

    expect(pi.registerTool).toHaveBeenCalledWith(
      expect.objectContaining({ name: "task_agent" }),
    );
  });

  it("tasks handle 缺失时 session_shutdown 不抛错", async () => {
    const pi: any = { ...fakePi, events: {} };
    localagentExtension(pi);
    const shutdownHandler = pi.on.mock.calls.find((c: any[]) => c[0] === "session_shutdown")![1];

    await expect(shutdownHandler()).resolves.toBeUndefined();
  });
});
