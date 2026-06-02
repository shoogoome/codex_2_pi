import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LocalAgentTask,
  _bindPi,
  _resetLocalAgentPiBindingForTest,
} from "./localAgentTask.js";
import { createTaskStore } from "../tasks/taskStore.js";

const fakePi: any = { events: {}, sendMessage: vi.fn() };

beforeEach(() => {
  _resetLocalAgentPiBindingForTest();
  fakePi.sendMessage.mockClear();
});

describe("LocalAgentTask", () => {
  it("name='LocalAgentTask',type='local_agent'", () => {
    expect(LocalAgentTask.name).toBe("LocalAgentTask");
    expect(LocalAgentTask.type).toBe("local_agent");
  });

  it("kill 调用前未 bind pi → throw", async () => {
    const store = createTaskStore();
    await expect(LocalAgentTask.kill("a1", store)).rejects.toThrow(/pi.*bound/i);
  });

  it("bind 后 kill 委托给 killLocalAgentTask(no-op for missing task)", async () => {
    _bindPi(fakePi);
    const store = createTaskStore();
    await LocalAgentTask.kill("nope", store as any);
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });
});
