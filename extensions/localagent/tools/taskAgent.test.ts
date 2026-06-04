import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTaskAgentTool, _setSpawnerForTest, _setTeammateSpawnerForTest } from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";
import { attachTeammateHandle } from "../../teammate/handle.js";
import { createTeamStore } from "../../teammate/teamStore.js";
import { createMailbox } from "../../teammate/mailbox.js";
import { createTeamTaskStore } from "../../teammate/teamTasks/teamTaskStore.js";

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

  it("description 含 claudecode 对齐的关键引导句(并发提示 + prompt 写作教学 + 例子)", () => {
    // Regression guard: the description was rewritten (commit chasing the
    // claudecode Task tool) so the LLM proactively dispatches sub-agents
    // for parallel investigation. If anyone shrinks the prompt back to a
    // routing-only blurb, these key sentences disappear and the LLM
    // reverts to "I'll just grep myself" behavior. Keep the strings short
    // enough that minor wording tweaks don't break the test, but specific
    // enough that the load-bearing intent is preserved.
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const desc = tool.description ?? "";
    // Concurrency directive — the single most important behavioral nudge.
    expect(desc).toMatch(/single message with multiple/i);
    // Foreground vs background decision.
    expect(desc).toMatch(/foreground/i);
    expect(desc).toMatch(/background/i);
    // Prompt-writing guidance.
    expect(desc).toMatch(/Brief the agent like/i);
    expect(desc).toMatch(/Never delegate understanding/i);
    // At least one example block to prime the format.
    expect(desc).toMatch(/<example>/);
  });

  it("description 含 claudecode 对齐的关键引导句(并发提示 + prompt 写作教学 + 例子)", () => {
    // Regression guard: the description was rewritten (commit chasing the
    // claudecode Task tool) so the LLM proactively dispatches sub-agents
    // for parallel investigation. If anyone shrinks the prompt back to a
    // routing-only blurb, these key sentences disappear and the LLM
    // reverts to "I'll just grep myself" behavior. Keep the strings short
    // enough that minor wording tweaks don't break the test, but specific
    // enough that the load-bearing intent is preserved.
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const desc = tool.description ?? "";
    // Concurrency directive — the single most important behavioral nudge.
    expect(desc).toMatch(/single message with multiple/i);
    // Foreground vs background decision.
    expect(desc).toMatch(/foreground/i);
    expect(desc).toMatch(/background/i);
    // Prompt-writing guidance.
    expect(desc).toMatch(/Brief the agent like/i);
    expect(desc).toMatch(/Never delegate understanding/i);
    // At least one example block to prime the format.
    expect(desc).toMatch(/<example>/);
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

function makeFakePiWithTeammateHandle(): any {
  const teamStore = createTeamStore();
  const mailbox = createMailbox();
  // Pre-create the team so spawnTeammate's validation passes (when not stubbed).
  teamStore.createTeam("research", undefined, 1);
  const pi: any = { events: {}, sendMessage: vi.fn(), getActiveTools: () => [] };
  attachTeammateHandle(pi as never, { teamStore, mailbox, teamTaskStore: createTeamTaskStore() });
  return pi;
}

function makeFakePiWithoutTeammateHandle(): any {
  return { events: {}, sendMessage: vi.fn(), getActiveTools: () => [] };
}

describe("task_agent — teammate route", () => {
  beforeEach(() => {
    _setTeammateSpawnerForTest(undefined);
    _setSpawnerForTest(undefined);
  });

  afterEach(() => {
    _setTeammateSpawnerForTest(undefined);
    _setSpawnerForTest(undefined);
  });

  it("team_name + name → calls spawnTeammate (mocked) and returns teammate-mode details", async () => {
    const fakeSpawner = vi.fn().mockResolvedValue({
      taskId: "t1",
      agentId: "alice@research",
      sessionFile: "/tmp/x.jsonl",
    });
    _setTeammateSpawnerForTest(fakeSpawner);

    const pi = makeFakePiWithTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    const result = await callTool(
      tool,
      {
        team_name: "research",
        name: "alice",
        subagent_type: "general-purpose",
        prompt: "find auth bugs",
        description: "auth audit",
      },
    );

    expect(fakeSpawner).toHaveBeenCalledTimes(1);
    const args = fakeSpawner.mock.calls[0]![3];
    expect(args.teamName).toBe("research");
    expect(args.agentName).toBe("alice");
    expect(args.agentType).toBe("general-purpose");
    expect(args.prompt).toBe("find auth bugs");
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect((result.details as { mode?: string }).mode).toBe("teammate");
    expect((result.details as { taskId?: string }).taskId).toBe("t1");
    expect((result.details as { agentId?: string }).agentId).toBe("alice@research");
    expect((result.content[0] as { text: string }).text).toMatch(/alice@research/);
    expect((result.content[0] as { text: string }).text).toMatch(/send_message/);
  });

  it("team_name without name → isError", async () => {
    const pi = makeFakePiWithTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    const result = await callTool(
      tool,
      { team_name: "research", prompt: "x", description: "x" },
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/team_name and name must both/);
  });

  it("name without team_name → isError", async () => {
    const pi = makeFakePiWithTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    const result = await callTool(
      tool,
      { name: "alice", prompt: "x", description: "x" },
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/team_name and name must both/);
  });

  it("teammate handle missing → isError 'teammate extension not loaded'", async () => {
    const pi = makeFakePiWithoutTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    const result = await callTool(
      tool,
      {
        team_name: "research",
        name: "alice",
        prompt: "x",
        description: "x",
      },
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/teammate extension/i);
  });

  it("spawnTeammate throws → isError with the message", async () => {
    const fakeSpawner = vi.fn().mockRejectedValue(new Error("Team 'ghost' does not exist"));
    _setTeammateSpawnerForTest(fakeSpawner);
    const pi = makeFakePiWithTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    const result = await callTool(
      tool,
      {
        team_name: "ghost",
        name: "alice",
        prompt: "x",
        description: "x",
      },
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/does not exist/);
  });

  it("no team_name and no name → still routes to LocalAgent (existing C-phase path)", async () => {
    const fakeTeammateSpawner = vi.fn();
    _setTeammateSpawnerForTest(fakeTeammateSpawner);
    const fakeLocalSpawner = vi.fn().mockResolvedValue({
      taskId: "t-local-1",
      status: "completed" as const,
      backgrounded: false,
      finalText: "done",
      toolCallCount: 0,
      tokenCount: 0,
      agentType: "general-purpose",
      outputFile: "/tmp/out",
    });
    _setSpawnerForTest(fakeLocalSpawner);
    const pi = makeFakePiWithTeammateHandle();
    const taskStore = createTaskStore();
    const tool = buildTaskAgentTool(pi, taskStore);
    await callTool(
      tool,
      {
        subagent_type: "general-purpose",
        prompt: "x",
        description: "x",
      },
    );
    expect(fakeTeammateSpawner).not.toHaveBeenCalled();
    expect(fakeLocalSpawner).toHaveBeenCalled();
  });
});
