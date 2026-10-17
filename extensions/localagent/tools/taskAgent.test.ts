import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildTaskAgentTool,
  _setSpawnerForTest,
  _setTeammateSpawnerForTest,
} from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";
import { attachTeammateHandle, createApprovalRequestRegistry } from "../../teammate/handle.js";
import { createTeamStore } from "../../teammate/teamStore.js";
import { createMailbox } from "../../teammate/mailbox.js";
import { createTeamTaskStore } from "../../teammate/teamTasks/teamTaskStore.js";

const parentModel = {
  id: "custom-model",
  provider: "custom-provider",
  name: "Custom Model",
  reasoning: true,
};

const fakePi: any = {
  events: {},
  sendMessage: vi.fn(),
  getActiveTools: () => ["read", "bash", "task_agent"],
  getThinkingLevel: () => "max",
};

const fakeCtx: any = {
  cwd: "/tmp",
  sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch: () => [] },
  model: parentModel,
  messages: [],
};

beforeEach(() => {
  fakePi.sendMessage.mockClear();
  _setSpawnerForTest(undefined);
  _setTeammateSpawnerForTest(undefined);
});

/** Register a teammate handle so the teammate route resolves. */
function attachFakeTeammateHandle(pi: any): void {
  attachTeammateHandle(pi, {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  });
}

/**
 * A pi stub with a private `events` object.
 *
 * Session handles live on `pi.events`, so sharing the shared `fakePi.events`
 * object across tests would leak one test's attached handle into the next.
 */
function freshPi(): any {
  return { ...fakePi, events: {} };
}

async function callTool(
  tool: ReturnType<typeof buildTaskAgentTool>,
  params: unknown,
  ctxOverride?: Record<string, unknown>,
) {
  return tool.execute(
    "call-1",
    params as never,
    new AbortController().signal,
    () => {},
    { ...fakeCtx, ...ctxOverride },
  );
}

describe("task_agent fork contract", () => {
  it("schema 公开 description、prompt、cwd，以及 teammate 模式的 team_name/name/subagent_type", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(tool.name).toBe("task_agent");
    expect(Object.keys((tool.parameters as any).properties).sort()).toEqual([
      "cwd",
      "description",
      "name",
      "prompt",
      "subagent_type",
      "team_name",
    ]);
    expect((tool.parameters as any).additionalProperties).toBe(false);
  });

  it("description 说明 fork 继承、后台执行，以及 teammate 模式", () => {
    const description = buildTaskAgentTool(fakePi, createTaskStore()).description ?? "";
    expect(description).toMatch(/background/i);
    expect(description).toMatch(/exact parent provider, model/i);
    expect(description).toMatch(/single assistant message/i);
    expect(description).toMatch(/automatic terminal notification/i);
    expect(description).toMatch(/team_name/);
    expect(description).toMatch(/long-lived teammate/i);
  });

  it.each(["model", "run_in_background", "isolation"])(
    "拒绝 fork 路径的旧参数 %s",
    async (key) => {
      const tool = buildTaskAgentTool(fakePi, createTaskStore());
      const result = await callTool(tool, {
        description: "x",
        prompt: "y",
        [key]: key === "model" ? "opus" : "legacy",
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain(key);
      expect((result.content[0] as { text: string }).text).toMatch(/inherit/i);
    },
  );

  it("只给 team_name 或缺 name 时明确报错，不静默走 fork", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    for (const params of [
      { description: "x", prompt: "y", team_name: "alpha" },
      { description: "x", prompt: "y", name: "bob" },
    ]) {
      const result = await callTool(tool, params);
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toMatch(
        /team_name and name must both be provided/i,
      );
    }
  });

  it("没有持久父 session 时明确失败", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const result = await callTool(
      tool,
      { description: "x", prompt: "y" },
      { sessionManager: { getSessionFile: () => undefined } },
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/--no-session/);
  });

  it("始终向 spawner 传递 fork 配置和主会话精确 provider/model/thinking", async () => {
    const spawner = vi.fn().mockResolvedValue({
      taskId: "a1",
      status: "running",
      backgrounded: true,
      agentType: "__fork__",
      toolCallCount: 0,
      tokenCount: 0,
      outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawner);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());

    const result = await callTool(tool, {
      description: "audit auth",
      prompt: "inspect auth",
      cwd: "/work",
    });

    const options = spawner.mock.calls[0]![2];
    expect(options).toMatchObject({
      prompt: "inspect auth",
      cwd: "/work",
      description: "audit auth",
      parentSessionFile: "/tmp/parent.jsonl",
      model: parentModel,
      thinkingLevel: "max",
      allRegisteredTools: ["read", "bash", "task_agent"],
    });
    expect(options.model).toBe(parentModel);
    expect(options.parentBranch).toEqual([]);
    expect((result.content[0] as { text: string }).text).toMatch(/Fork backgrounded/);
    expect(result.details).toMatchObject({
      action: "task_agent",
      taskId: "a1",
      agentType: "__fork__",
      status: "running",
      isBackgrounded: true,
    });
  });

  it("捕获活动分支，不读取包含其他分支的全量条目", async () => {
    const branch = [{ type: "message", id: "active", parentId: null, message: { role: "user", content: "current" } }];
    const spawner = vi.fn().mockResolvedValue({
      taskId: "a1", status: "running", backgrounded: true,
      agentType: "__fork__", toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawner);
    const getBranch = vi.fn(() => branch);
    const getEntries = vi.fn(() => { throw new Error("must not read archive"); });
    const result = await callTool(buildTaskAgentTool(fakePi, createTaskStore()),
      { description: "x", prompt: "y" },
      { sessionManager: { getSessionFile: () => "/tmp/parent.jsonl", getBranch, getEntries } },
    );
    expect((result as { isError?: boolean }).isError).not.toBe(true);
    expect(spawner.mock.calls[0]![2].parentBranch).toBe(branch);
    expect(getBranch).toHaveBeenCalledTimes(1);
    expect(getEntries).not.toHaveBeenCalled();
  });

  it("spawner 返回非后台结果时按内部契约错误处理", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1",
      status: "completed",
      backgrounded: false,
      agentType: "__fork__",
      finalText: "unexpected",
      toolCallCount: 0,
      tokenCount: 0,
      outputFile: "/tmp/a1.out",
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const result = await callTool(tool, { description: "x", prompt: "y" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/background-only/);
  });

  it("spawner 异常转为 tool error", async () => {
    _setSpawnerForTest(vi.fn().mockRejectedValue(new Error("boom")));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const result = await callTool(tool, { description: "x", prompt: "y" });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/boom/);
  });

  it("signal 已中止时不启动 fork", async () => {
    const spawner = vi.fn();
    _setSpawnerForTest(spawner);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const controller = new AbortController();
    controller.abort();

    const result = await tool.execute(
      "call-1",
      { description: "x", prompt: "y" },
      controller.signal,
      undefined,
      fakeCtx,
    );

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/aborted/i);
    expect(spawner).not.toHaveBeenCalled();
  });
});

describe("task_agent teammate route", () => {
  it("team_name + name → 调用 spawnTeammate 并返回 teammate-mode details", async () => {
    const pi = freshPi();
    attachFakeTeammateHandle(pi);
    const spawner = vi.fn().mockResolvedValue({
      taskId: "t1",
      agentId: "bob@alpha",
      sessionFile: "/tmp/bob.jsonl",
    });
    _setTeammateSpawnerForTest(spawner);
    const tool = buildTaskAgentTool(pi, createTaskStore());

    const result = await callTool(tool, {
      description: "spawn bob",
      prompt: "audit the parser",
      team_name: "alpha",
      name: "bob",
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details).toMatchObject({
      action: "task_agent",
      mode: "teammate",
      taskId: "t1",
      agentId: "bob@alpha",
      sessionFile: "/tmp/bob.jsonl",
    });
    expect((result.content[0] as { text: string }).text).toContain("bob@alpha");

    const opts = spawner.mock.calls[0]![3];
    expect(opts).toMatchObject({
      teamName: "alpha",
      agentName: "bob",
      prompt: "audit the parser",
      cwd: "/tmp",
      model: parentModel,
      thinkingLevel: "max",
    });
    // Defaults to the built-in general-purpose role.
    expect(opts.agentDef.agentType).toBe("general-purpose");
  });

  it("subagent_type 选择 role，并把 role system prompt 交给 spawner", async () => {
    const pi = freshPi();
    attachFakeTeammateHandle(pi);
    const spawner = vi.fn().mockResolvedValue({
      taskId: "t2",
      agentId: "eve@alpha",
      sessionFile: "/tmp/eve.jsonl",
    });
    _setTeammateSpawnerForTest(spawner);
    const tool = buildTaskAgentTool(pi, createTaskStore());

    await callTool(tool, {
      description: "spawn explorer",
      prompt: "map the repo",
      team_name: "alpha",
      name: "eve",
      subagent_type: "explore",
    });

    const opts = spawner.mock.calls[0]![3];
    expect(opts.agentDef.agentType).toBe("explore");
    expect(opts.agentDef.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("未知 subagent_type 报错并列出可选 role", async () => {
    const pi = freshPi();
    attachFakeTeammateHandle(pi);
    _setTeammateSpawnerForTest(vi.fn());
    const tool = buildTaskAgentTool(pi, createTaskStore());

    const result = await callTool(tool, {
      description: "x",
      prompt: "y",
      team_name: "alpha",
      name: "bob",
      subagent_type: "nope",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('Unknown subagent_type "nope"');
    expect(text).toContain("general-purpose");
    expect(text).toContain("explore");
  });

  it("teammate handle 未加载时报错且不调用 spawner", async () => {
    const spawner = vi.fn();
    _setTeammateSpawnerForTest(spawner);
    const tool = buildTaskAgentTool(freshPi(), createTaskStore());

    const result = await callTool(tool, {
      description: "x",
      prompt: "y",
      team_name: "alpha",
      name: "bob",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/teammate extension not loaded/i);
    expect(spawner).not.toHaveBeenCalled();
  });

  it("spawnTeammate 抛错时转为 tool error", async () => {
    const pi = freshPi();
    attachFakeTeammateHandle(pi);
    _setTeammateSpawnerForTest(vi.fn().mockRejectedValue(new Error("team 'alpha' does not exist")));
    const tool = buildTaskAgentTool(pi, createTaskStore());

    const result = await callTool(tool, {
      description: "x",
      prompt: "y",
      team_name: "alpha",
      name: "bob",
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("team 'alpha' does not exist");
  });
});

describe("task_agent rendering", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => text,
  } as never;

  function render(component: unknown): string {
    return (component as { render(width: number): string[] }).render(160).join("\n");
  }

  it("运行中的 fork 仅由任务面板展示，主流为空", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const output = tool.renderResult!(
      {
        content: [{ type: "text", text: "running" }],
        details: {
          action: "task_agent",
          taskId: "a1",
          agentType: "__fork__",
          status: "running",
          isBackgrounded: true,
        },
      } as never,
      { isPartial: false, expanded: false },
      theme,
      {} as never,
    );
    expect(render(output)).toBe("");
  });

  it("renderCall 不向主消息流写重复状态", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const output = tool.renderCall!(
      { description: "audit", prompt: "x" },
      theme,
      {} as never,
    );
    expect(render(output)).toBe("");
  });
});
