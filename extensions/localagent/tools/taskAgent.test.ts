import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildTaskAgentTool, _setSpawnerForTest } from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";

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
  sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
  model: parentModel,
  messages: [],
};

beforeEach(() => {
  fakePi.sendMessage.mockClear();
  _setSpawnerForTest(undefined);
});

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

describe("task_agent fork-only contract", () => {
  it("schema 只公开 description、prompt 和 cwd", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(tool.name).toBe("task_agent");
    expect(Object.keys((tool.parameters as any).properties).sort()).toEqual([
      "cwd",
      "description",
      "prompt",
    ]);
    expect((tool.parameters as any).additionalProperties).toBe(false);
  });

  it("description 明确 fork-only、后台执行和 provider/model 精确继承", () => {
    const description = buildTaskAgentTool(fakePi, createTaskStore()).description ?? "";
    expect(description).toMatch(/fork mode only/i);
    expect(description).toMatch(/background/i);
    expect(description).toMatch(/exact parent provider, model/i);
    expect(description).toMatch(/single assistant message/i);
    expect(description).toMatch(/automatic terminal notification/i);
  });

  it.each(["subagent_type", "model", "run_in_background", "team_name", "name", "isolation"])(
    "拒绝旧参数 %s",
    async (key) => {
      const tool = buildTaskAgentTool(fakePi, createTaskStore());
      const result = await callTool(tool, {
        description: "x",
        prompt: "y",
        [key]: key === "model" ? "opus" : "legacy",
      });
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect((result.content[0] as { text: string }).text).toContain(key);
      expect((result.content[0] as { text: string }).text).toMatch(/fork mode only/i);
    },
  );

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
    expect((result.content[0] as { text: string }).text).toMatch(/Fork backgrounded/);
    expect(result.details).toMatchObject({
      action: "task_agent",
      taskId: "a1",
      agentType: "__fork__",
      status: "running",
      isBackgrounded: true,
    });
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
