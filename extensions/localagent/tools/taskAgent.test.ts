import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildTaskAgentTool, _setSpawnerForTest, _setTeammateSpawnerForTest } from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";
import { attachTeammateHandle } from "../../teammate/handle.js";
import { createTeamStore } from "../../teammate/teamStore.js";
import { createMailbox } from "../../teammate/mailbox.js";
import { createTeamTaskStore } from "../../teammate/teamTasks/teamTaskStore.js";

const fakePi: any = {
  events: {},
  sendMessage: vi.fn(),
  getActiveTools: () => [],
  getThinkingLevel: () => "medium",
};
const fakeCtx: any = {
  cwd: "/tmp",
  sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
  model: { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet" },
  modelRegistry: {
    getAvailable: () => [
      { id: "claude-sonnet-4-6", provider: "anthropic", name: "Claude Sonnet" },
      { id: "claude-opus-4-6", provider: "anthropic", name: "Claude Opus" },
      { id: "claude-haiku-4-5", provider: "anthropic", name: "Claude Haiku" },
    ],
  },
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

  it("execute 在 signal 已 abort 时早返回 isError(Esc 在 task 启动前按)", async () => {
    // Regression for the original bug where execute ignored its third arg
    // (named _signal). The earliest-abort path is testable without
    // spinning up a real LLM session.
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const ac = new AbortController();
    ac.abort();
    const r = await tool.execute(
      "call-1",
      { description: "x", prompt: "y", subagent_type: "general-purpose" },
      ac.signal,
      undefined,
      { cwd: process.cwd(), sessionManager: { getSessionFile: () => undefined } } as never,
    );
    expect((r as { isError?: boolean }).isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/aborted/i);
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
    expect(spawnerMock.mock.calls[0]![2]!.model).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
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
  const pi: any = {
    events: {},
    sendMessage: vi.fn(),
    getActiveTools: () => [],
    getThinkingLevel: () => "medium",
  };
  attachTeammateHandle(pi as never, { teamStore, mailbox, teamTaskStore: createTeamTaskStore() });
  return pi;
}

function makeFakePiWithoutTeammateHandle(): any {
  return {
    events: {},
    sendMessage: vi.fn(),
    getActiveTools: () => [],
    getThinkingLevel: () => "medium",
  };
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
    expect(args.agentDef.agentType).toBe("general-purpose");
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

describe("task_agent renderResult", () => {
  // Plain mock theme: fg/bold pass-through with a tag prefix so we can
  // assert which color tokens are used. e.g. theme.fg("success", "✓") →
  // "[success]✓" — matching `[success]` confirms the renderer asked for
  // the success color, regardless of the underlying ANSI palette.
  function tagTheme() {
    return {
      fg: (color: string, text: string) => `[${color}]${text}`,
      bold: (text: string) => `<b>${text}</b>`,
      bg: (_color: string, text: string) => text,
    };
  }

  function renderToString(component: unknown): string {
    const c = component as { render?: (w: number) => string[] };
    if (typeof c.render === "function") {
      return c.render(200).join("\n");
    }
    return JSON.stringify(component);
  }

  function getRenderResult(): NonNullable<ReturnType<typeof buildTaskAgentTool>["renderResult"]> {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(typeof tool.renderResult).toBe("function");
    return tool.renderResult!;
  }

  it("isPartial → empty Text (main stream stays blank; panel widget is the running surface)", () => {
    // Claudecode-style: while a task_agent is running, the main stream
    // shows nothing — only the task panel widget surfaces live status.
    // The main stream picks up the completion line via the terminal
    // renderResult call once the spawn promise resolves.
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "running…" }],
        details: {
          action: "task_agent",
          agentType: "general-purpose",
          description: "do work",
          status: "running",
          timeline: [
            { kind: "task_start", ts: 0, summary: "start" },
            { kind: "tool_start", ts: 1, summary: "bash(...)" },
          ],
        },
      } as never,
      { isPartial: true, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    // Empty Text — no agent type / description / event count painted.
    expect(blob).toBe("");
  });

  it("non-partial running (status=running, isPartial=false) → also empty Text", () => {
    // Defensive: even outside the partial-update path, a still-running
    // task should not paint head + Ctrl+O hint into the main stream.
    // The terminal head only appears once status flips to completed /
    // killed / failed (covered by the existing 'collapsed terminal' test).
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "task_agent",
          status: "running",
          agentType: "general-purpose",
          description: "do work",
          toolCallCount: 1,
          tokenCount: 100,
          timeline: [{ kind: "task_start", ts: 0, summary: "start" }],
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    expect(renderToString(out)).toBe("");
  });

  it("backgrounded → 'task_agent backgrounded' line with taskId", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "Backgrounded" }],
        details: {
          action: "task_agent",
          isBackgrounded: true,
          taskId: "ax42abcd",
          agentType: "general-purpose",
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    expect(blob).toContain("backgrounded");
    expect(blob).toContain("ax42abcd");
  });

  it("collapsed terminal: head + (N events · Ctrl+O) hint", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "全部找到了" }],
        details: {
          action: "task_agent",
          status: "completed",
          agentType: "general-purpose",
          description: "find auth bugs",
          toolCallCount: 3,
          tokenCount: 12300,
          durationMs: 83000,
          timeline: [
            { kind: "task_start", ts: 0, summary: "start" },
            { kind: "tool_start", ts: 1, summary: "bash(...)" },
            { kind: "tool_end", ts: 2, summary: "bash → 3 hits", isError: false },
          ],
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    // Head row carries the success glyph, agent type, and stats.
    expect(blob).toContain("✓");
    expect(blob).toContain("[success]");
    expect(blob).toContain("general-purpose");
    expect(blob).toContain("find auth bugs");
    expect(blob).toContain("3 tools");
    expect(blob).toContain("12.3k tokens");
    expect(blob).toContain("1m 23s");
    // Hint is dim and references Ctrl+O.
    expect(blob).toContain("3 events");
    expect(blob).toContain("Ctrl+O");
    // Final text is NOT painted in collapsed mode.
    expect(blob).not.toContain("全部找到了");
  });

  it("collapsed with empty timeline → head only (no Ctrl+O hint)", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "task_agent",
          status: "completed",
          agentType: "general-purpose",
          toolCallCount: 0,
          tokenCount: 0,
          durationMs: 0,
          timeline: [],
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    expect(blob).toContain("general-purpose");
    expect(blob).not.toContain("Ctrl+O");
    expect(blob).not.toContain("events");
  });

  it("expanded: head + timeline rows + ── final ── + finalText", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "完成报告:三处修复" }],
        details: {
          action: "task_agent",
          status: "completed",
          agentType: "general-purpose",
          description: "audit",
          toolCallCount: 1,
          tokenCount: 100,
          durationMs: 1000,
          timeline: [
            { kind: "task_start", ts: 0, summary: "general-purpose → audit" },
            { kind: "tool_start", ts: 1, summary: "grep(\"oldAuth\")" },
            { kind: "tool_end", ts: 2, summary: "grep → 5 hits", isError: false },
            { kind: "task_end", ts: 3, summary: "done (turns=2, tools=1)" },
          ],
        },
      } as never,
      { isPartial: false, expanded: true },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    expect(blob).toContain("general-purpose → audit");
    expect(blob).toContain("grep(\"oldAuth\")");
    expect(blob).toContain("grep → 5 hits");
    expect(blob).toContain("done (turns=2, tools=1)");
    expect(blob).toContain("── final ──");
    expect(blob).toContain("完成报告:三处修复");
    // Expanded mode should NOT show the Ctrl+O hint.
    expect(blob).not.toContain("Ctrl+O");
  });

  it("status=killed → ■ glyph painted with warning color", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "task_agent",
          status: "killed",
          agentType: "general-purpose",
          toolCallCount: 0,
          tokenCount: 0,
          durationMs: 0,
          timeline: [],
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    expect(blob).toContain("■");
    expect(blob).toContain("[warning]");
  });

  it("status=failed → ✗ glyph painted with error color", () => {
    const renderResult = getRenderResult();
    const out = renderResult(
      {
        content: [{ type: "text", text: "" }],
        details: {
          action: "task_agent",
          status: "failed",
          agentType: "general-purpose",
          toolCallCount: 0,
          tokenCount: 0,
          durationMs: 0,
          timeline: [],
        },
      } as never,
      { isPartial: false, expanded: false },
      tagTheme() as never,
      {} as never,
    );
    const blob = renderToString(out);
    expect(blob).toContain("✗");
    expect(blob).toContain("[error]");
  });

  it("renderCall returns empty Text (running surface is the panel widget, not the main stream)", () => {
    // Claudecode-style: the moment a task_agent call is constructed we
    // do NOT paint a head into the main stream. The panel widget owns
    // the running surface; renderResult paints the head only when the
    // tool result arrives in terminal state.
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(typeof tool.renderCall).toBe("function");
    const out = tool.renderCall!(
      { description: "audit", subagent_type: "general-purpose", prompt: "x" } as never,
      tagTheme() as never,
      {} as never,
    );
    expect(renderToString(out)).toBe("");
  });
});

describe("task_agent — sync result.timeline forwarded to details", () => {
  it("sync completion → details.timeline + details.durationMs forwarded from spawner", async () => {
    _setSpawnerForTest(
      vi.fn().mockResolvedValue({
        taskId: "a1",
        status: "completed",
        backgrounded: false,
        agentType: "general-purpose",
        finalText: "done",
        toolCallCount: 2,
        tokenCount: 100,
        outputFile: "/tmp/a1.out",
        durationMs: 5000,
        timeline: [
          { kind: "task_start", ts: 0, summary: "start" },
          { kind: "tool_end", ts: 1, summary: "ok", isError: false },
        ],
      }),
    );
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, {
      description: "test",
      prompt: "y",
      subagent_type: "general-purpose",
    });
    const details = r.details as {
      timeline?: Array<{ kind: string }>;
      durationMs?: number;
      description?: string;
    };
    expect(details.timeline).toBeDefined();
    expect(details.timeline).toHaveLength(2);
    expect(details.durationMs).toBe(5000);
    expect(details.description).toBe("test");
  });
});
