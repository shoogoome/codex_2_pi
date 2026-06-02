import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTaskAgentTool, _setSpawnerForTest } from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";

const fakePi: any = { events: {}, sendMessage: vi.fn(), getActiveTools: () => [] };
const fakeCtx: any = {
  cwd: "/tmp",
  sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
  model: { id: "opus", provider: "anthropic" },
  messages: [],
};

beforeEach(() => {
  fakePi.sendMessage.mockClear();
  _setSpawnerForTest(undefined);
});

async function callTool(tool: ReturnType<typeof buildTaskAgentTool>, params: unknown, ctxOverride?: any) {
  return await tool.execute("call-1", params as never, new AbortController().signal, () => {}, { ...fakeCtx, ...ctxOverride });
}

describe("task_agent tool", () => {
  it("tool name + parameters 存在", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(tool.name).toBe("task_agent");
    expect(tool.parameters).toBeDefined();
  });

  it("subagent_type 不存在 → isError + 列出可用名", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "no_such" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/no_such/);
    expect(text).toMatch(/general-purpose/);
  });

  it("isolation: 'worktree' → isError 'not yet supported'", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", isolation: "worktree" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/not yet supported/i);
  });

  it("subagent_type 省略 + 父 session 有文件 → fork 路径,返 backgrounded", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "running", backgrounded: true, agentType: "__fork__",
      toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "do it" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/Backgrounded/);
    expect(text).toMatch(/a1/);
  });

  it("subagent_type 省略 + 父 session 无文件 → isError", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y" }, {
      sessionManager: { getSessionFile: () => undefined },
    });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/--no-session/);
  });

  it("同步路径 → 返 finalText", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "全部找到了", toolCallCount: 5, tokenCount: 1200, outputFile: "/tmp/a1.out", durationMs: 8000,
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toBe("全部找到了");
  });

  it("run_in_background:true → 返 backgrounded 即使没 fork", async () => {
    const spawnerMock = vi.fn().mockResolvedValue({
      taskId: "a1", status: "running", backgrounded: true, agentType: "general-purpose",
      toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawnerMock);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", run_in_background: true });
    expect(spawnerMock.mock.calls[0]![2]!.forceBackground).toBe(true);
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/Backgrounded/);
  });

  it("model='opus' 透传到 spawner", async () => {
    const spawnerMock = vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "ok", toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawnerMock);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", model: "opus" });
    expect(spawnerMock.mock.calls[0]![2]!.model).toBe("opus");
  });

  it("spawner throw → tool 返 isError + stack 摘要", async () => {
    _setSpawnerForTest(vi.fn().mockRejectedValue(new Error("boom")));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/boom/);
  });

  it("details.action='task_agent' + taskId 在 details 里", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "ok", toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    expect((r.details as any)!.action).toBe("task_agent");
    expect((r.details as any)!.taskId).toBe("a1");
  });
});
