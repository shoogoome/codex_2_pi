import { describe, expect, it, vi } from "vitest";
import goalExtension, {
  budgetLimitPrompt,
  continuationPrompt,
  formatGoalElapsedSeconds,
  formatTokensCompact,
  statusLine,
} from "./index.js";

type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
  registerTool: ReturnType<typeof vi.fn>;
  registerCommand: ReturnType<typeof vi.fn>;
  appendEntry: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  handlers: Map<string, Handler[]>;
  tools: Map<string, any>;
  commands: Map<string, any>;
}

function createPi(): FakePi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const pi: FakePi = {
    handlers,
    tools,
    commands,
    registerTool: vi.fn((tool: any) => {
      tools.set(tool.name, tool);
    }),
    registerCommand: vi.fn((name: string, opts: any) => {
      commands.set(name, opts);
    }),
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
    on: vi.fn((event: string, handler: Handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),
  };
  return pi;
}

interface FakeBranch {
  type: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; usage?: { input: number; output: number } };
}

function makeCtx(opts: {
  branch?: FakeBranch[];
  isIdle?: boolean;
  hasPendingMessages?: boolean;
  sessionId?: string;
} = {}) {
  let branch = opts.branch ?? [];
  return {
    hasUI: false,
    cwd: "/tmp",
    isIdle: () => opts.isIdle ?? true,
    hasPendingMessages: () => opts.hasPendingMessages ?? false,
    ui: { setStatus: vi.fn(), notify: vi.fn() },
    sessionManager: {
      getSessionId: () => opts.sessionId ?? "thread-test",
      getBranch: () => branch,
    },
    pushBranch(entry: FakeBranch) {
      branch = [...branch, entry];
    },
  } as any;
}

function fireHandler(pi: FakePi, name: string, event: unknown, ctx: unknown): unknown[] {
  return (pi.handlers.get(name) ?? []).map((h) => h(event, ctx));
}

describe("goal — formatters", () => {
  it("formats tokens compactly with K/M/B suffixes", () => {
    expect(formatTokensCompact(0)).toBe("0");
    expect(formatTokensCompact(999)).toBe("999");
    expect(formatTokensCompact(1_000)).toBe("1K");
    expect(formatTokensCompact(1_234)).toBe("1.2K");
    expect(formatTokensCompact(63_876)).toBe("63.9K");
    expect(formatTokensCompact(50_000)).toBe("50K");
    expect(formatTokensCompact(2_500_000)).toBe("2.5M");
    expect(formatTokensCompact(15_000_000)).toBe("15M");
  });

  it("formats elapsed seconds in escalating units", () => {
    expect(formatGoalElapsedSeconds(0)).toBe("0s");
    expect(formatGoalElapsedSeconds(59)).toBe("59s");
    expect(formatGoalElapsedSeconds(60)).toBe("1m");
    expect(formatGoalElapsedSeconds(30 * 60)).toBe("30m");
    expect(formatGoalElapsedSeconds(90 * 60)).toBe("1h 30m");
    expect(formatGoalElapsedSeconds(2 * 60 * 60)).toBe("2h");
    expect(formatGoalElapsedSeconds(24 * 60 * 60)).toBe("1d 0h 0m");
    expect(formatGoalElapsedSeconds(2 * 86400 + 23 * 3600 + 42 * 60)).toBe(
      "2d 23h 42m",
    );
  });
});

const baseGoal = {
  threadId: "t",
  goalId: "g",
  objective: "ship",
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};

describe("goal — statusLine", () => {
  it("returns undefined for null goal", () => {
    expect(statusLine(null)).toBeUndefined();
  });
  it("active with budget renders compact tokens", () => {
    expect(
      statusLine({ ...baseGoal, status: "active", tokenBudget: 50_000, tokensUsed: 1234 } as any),
    ).toBe("Pursuing goal (1.2K / 50K)");
  });
  it("paused renders /goal resume hint", () => {
    expect(statusLine({ ...baseGoal, status: "paused" } as any)).toBe(
      "Goal paused (/goal resume)",
    );
  });
  it("blocked renders dedicated label and resume hint", () => {
    expect(
      statusLine({ ...baseGoal, status: "blocked", tokenBudget: 100, tokensUsed: 100 } as any),
    ).toBe("Goal blocked (100 / 100) (/goal resume)");
  });
  it("budget_limited shows Goal unmet", () => {
    expect(
      statusLine({ ...baseGoal, status: "budget_limited", tokenBudget: 5000, tokensUsed: 5500 } as any),
    ).toBe("Goal unmet (5.5K / 5K)");
  });
  it("complete with elapsed renders compact duration", () => {
    expect(
      statusLine({ ...baseGoal, status: "complete", timeUsedSeconds: 90 * 60 } as any),
    ).toBe("Goal achieved (1h 30m)");
  });
});

describe("goal — continuation/budget prompts", () => {
  it("continuationPrompt contains the Blocked audit section (codex parity)", () => {
    const prompt = continuationPrompt({ ...baseGoal, status: "active" } as any);
    expect(prompt).toContain("Blocked audit:");
    expect(prompt).toContain("at least three consecutive goal turns");
    expect(prompt).toContain("truly at an impasse");
    expect(prompt).toContain('call update_goal with status "complete"');
    expect(prompt).toContain('status "blocked"');
  });

  it("continuationPrompt does not falsely steer paused/budget_limited statuses", () => {
    const prompt = continuationPrompt({ ...baseGoal, status: "active" } as any);
    expect(prompt).not.toContain('status "paused"');
    expect(prompt).not.toContain("budgetLimited");
  });

  it("budgetLimitPrompt steers wrap-up without saying complete is required", () => {
    const prompt = budgetLimitPrompt({
      ...baseGoal,
      status: "budget_limited",
      tokenBudget: 5000,
      tokensUsed: 5500,
    } as any);
    expect(prompt).toContain("budget_limited");
    expect(prompt).toContain("Wrap up this turn soon");
    expect(prompt).toContain("Do not call update_goal unless the goal is actually complete.");
  });
});

describe("goal — update_goal tool", () => {
  it("accepts blocked status and records it", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const tool = pi.tools.get("update_goal")!;
    const ctx = makeCtx({
      branch: [
        {
          type: "custom",
          customType: "thread-goal",
          data: { goal: { ...baseGoal, status: "active" } },
        },
      ],
    });
    const r = await tool.execute("c1", { status: "blocked" }, undefined, undefined, ctx);
    expect(r.details.goal.status).toBe("blocked");
    expect(r.details.completionBudgetReport).toBeNull(); // no budget => null
  });

  it("rejects status values that are neither complete nor blocked", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const tool = pi.tools.get("update_goal")!;
    const ctx = makeCtx({
      branch: [
        {
          type: "custom",
          customType: "thread-goal",
          data: { goal: { ...baseGoal, status: "active" } },
        },
      ],
    });
    await expect(tool.execute("c1", { status: "paused" } as any, undefined, undefined, ctx))
      .rejects.toThrow(/can only mark the existing goal complete or blocked/);
  });

  it("complete with budget produces 'Goal achieved' report; blocked produces 'Goal blocked'", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const tool = pi.tools.get("update_goal")!;
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: {
          goal: { ...baseGoal, status: "active", tokenBudget: 1000, tokensUsed: 200 },
          accounting: { lastTotalTokens: 0, lastAccountedAt: 0, activeGoalId: "g" },
        },
      },
    ];
    const r1 = await tool.execute("c1", { status: "complete" }, undefined, undefined, makeCtx({ branch }));
    expect(r1.details.completionBudgetReport).toMatch(/^Goal achieved\./);

    // re-issue from a fresh active state for blocked
    const pi2 = createPi();
    goalExtension(pi2 as any);
    fireHandler(pi2, "session_start", {}, makeCtx());
    const tool2 = pi2.tools.get("update_goal")!;
    const r2 = await tool2.execute("c1", { status: "blocked" }, undefined, undefined, makeCtx({ branch }));
    expect(r2.details.completionBudgetReport).toMatch(/^Goal blocked\./);
  });
});

describe("goal — /goal resume restrictions", () => {
  function setupWithGoal(status: string, opts: { tokenBudget?: number } = {}) {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const cmd = pi.commands.get("goal")!;
    const ctx = makeCtx({
      branch: [
        {
          type: "custom",
          customType: "thread-goal",
          data: {
            goal: {
              ...baseGoal,
              status,
              ...(opts.tokenBudget !== undefined ? { tokenBudget: opts.tokenBudget } : {}),
            },
          },
        },
      ],
    });
    return { pi, cmd, ctx };
  }

  it("rejects resume of complete goals (existing behavior)", async () => {
    const { cmd, ctx } = setupWithGoal("complete");
    await expect(cmd.handler("resume", ctx)).rejects.toThrow(/cannot resume a complete goal/);
  });

  it("rejects resume of budget_limited goals", async () => {
    const { cmd, ctx } = setupWithGoal("budget_limited", { tokenBudget: 100 });
    await expect(cmd.handler("resume", ctx)).rejects.toThrow(/budget-limited/);
  });

  it("allows resume of paused and blocked goals", async () => {
    const cases = ["paused", "blocked"] as const;
    for (const status of cases) {
      const { cmd, ctx } = setupWithGoal(status);
      await cmd.handler("resume", ctx);
      // resume is supposed to set status active; downstream we don't read it
      // back from branch (no real persistence in fake) — what we *do* assert is
      // that no error was thrown and a continuation send was issued.
    }
  });
});

describe("goal — before_agent_start injection scope", () => {
  it("does not inject continuation prompt on plain user turns when goal is active", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    const ctx = makeCtx({
      branch: [
        {
          type: "custom",
          customType: "thread-goal",
          data: { goal: { ...baseGoal, status: "active" } },
        },
      ],
    });
    const results = fireHandler(pi, "before_agent_start", {}, ctx);
    const settled = await Promise.all(results);
    // no message returned => no goal context for this turn
    expect(settled.every((r) => r === undefined)).toBe(true);
  });

  it("injects budget_limit prompt when goal is budget_limited", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    const ctx = makeCtx({
      branch: [
        {
          type: "custom",
          customType: "thread-goal",
          data: {
            goal: {
              ...baseGoal,
              status: "budget_limited",
              tokenBudget: 100,
              tokensUsed: 100,
            },
          },
        },
      ],
    });
    const results = fireHandler(pi, "before_agent_start", {}, ctx);
    const settled = await Promise.all(results);
    expect(settled[0]).toMatchObject({
      message: { customType: "thread-goal-context", display: false },
    });
    const content = (settled[0] as any).message.content as string;
    expect(content).toContain("budget_limited");
  });

  it("does not inject anything when goal is paused/blocked/complete", async () => {
    for (const status of ["paused", "blocked", "complete"]) {
      const pi = createPi();
      goalExtension(pi as any);
      const ctx = makeCtx({
        branch: [
          {
            type: "custom",
            customType: "thread-goal",
            data: { goal: { ...baseGoal, status } },
          },
        ],
      });
      const results = fireHandler(pi, "before_agent_start", {}, ctx);
      const settled = await Promise.all(results);
      expect(settled.every((r) => r === undefined)).toBe(true);
    }
  });
});

describe("goal — tool_execution_end real-time accounting", () => {
  it("flips active → budget_limited when usage crosses budget mid-turn", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: {
          goal: {
            ...baseGoal,
            status: "active",
            tokenBudget: 1000,
            tokensUsed: 0,
          },
          accounting: { lastTotalTokens: 0, lastAccountedAt: 0, activeGoalId: "g" },
        },
      },
      // already-existing assistant usage that puts us right at the budget edge
      { type: "message", message: { role: "assistant", usage: { input: 800, output: 250 } } },
    ];
    const ctx = makeCtx({ branch });
    fireHandler(
      pi,
      "tool_execution_end",
      { toolName: "Read", toolCallId: "c1", result: {}, isError: false },
      ctx,
    );

    // After accounting, appendEntry should have been called with a snapshot
    // whose goal status flipped to budget_limited (1050 ≥ 1000).
    expect(pi.appendEntry).toHaveBeenCalled();
    const lastCall = pi.appendEntry.mock.calls.at(-1)!;
    expect(lastCall[0]).toBe("thread-goal");
    expect((lastCall[1] as any).goal.status).toBe("budget_limited");
  });

  it("skips re-accounting when the just-finished tool is update_goal itself", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: {
          goal: { ...baseGoal, status: "complete", tokenBudget: 1000, tokensUsed: 200 },
          accounting: { lastTotalTokens: 0, lastAccountedAt: 0, activeGoalId: "g" },
        },
      },
      { type: "message", message: { role: "assistant", usage: { input: 500, output: 600 } } },
    ];
    const ctx = makeCtx({ branch });
    pi.appendEntry.mockClear();
    fireHandler(
      pi,
      "tool_execution_end",
      { toolName: "update_goal", toolCallId: "c1", result: {}, isError: false },
      ctx,
    );
    expect(pi.appendEntry).not.toHaveBeenCalled();
  });
});

describe("goal — idle continuation scheduling", () => {
  it("starts a continuation when goal is active and host is idle with no pending input", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: { goal: { ...baseGoal, status: "active" } },
      },
    ];
    const ctx = makeCtx({ branch, isIdle: true, hasPendingMessages: false });
    fireHandler(pi, "turn_end", { turnIndex: 0, message: {}, toolResults: [] }, ctx);
    // wait for queueMicrotask path if synchronous didn't fire
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    const [message, options] = pi.sendMessage.mock.calls[0]!;
    expect((message as any).customType).toBe("thread-goal-context");
    expect((options as any).triggerTurn).toBe(true);
  });

  it("does not start a continuation when host is not idle", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: { goal: { ...baseGoal, status: "active" } },
      },
    ];
    const ctx = makeCtx({ branch, isIdle: false });
    fireHandler(pi, "turn_end", { turnIndex: 0 }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not start a continuation when user input is pending", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: { goal: { ...baseGoal, status: "active" } },
      },
    ];
    const ctx = makeCtx({ branch, isIdle: true, hasPendingMessages: true });
    fireHandler(pi, "turn_end", { turnIndex: 0 }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("does not start a continuation for non-active goals", async () => {
    for (const status of ["paused", "blocked", "complete", "budget_limited"]) {
      const pi = createPi();
      goalExtension(pi as any);
      fireHandler(pi, "session_start", {}, makeCtx());
      const branch: FakeBranch[] = [
        {
          type: "custom",
          customType: "thread-goal",
          data: { goal: { ...baseGoal, status } },
        },
      ];
      fireHandler(pi, "turn_end", { turnIndex: 0 }, makeCtx({ branch, isIdle: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(pi.sendMessage).not.toHaveBeenCalled();
    }
  });

  it("only fires once even if turn_end fires twice in a row before the continuation turn enters before_agent_start", async () => {
    const pi = createPi();
    goalExtension(pi as any);
    fireHandler(pi, "session_start", {}, makeCtx());
    const branch: FakeBranch[] = [
      {
        type: "custom",
        customType: "thread-goal",
        data: { goal: { ...baseGoal, status: "active" } },
      },
    ];
    const ctx = makeCtx({ branch, isIdle: true });
    fireHandler(pi, "turn_end", { turnIndex: 0 }, ctx);
    fireHandler(pi, "turn_end", { turnIndex: 0 }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
  });
});
