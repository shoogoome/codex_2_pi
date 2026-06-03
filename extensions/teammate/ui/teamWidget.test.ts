import { describe, it, expect } from "vitest";
import { renderTeamWidget } from "./teamWidget.js";
import type { TeamState, InProcessTeammateTaskState } from "../types.js";
import { createTaskStateBase } from "../../tasks/Task.js";

function buildTask(
  agentName: string,
  teamName: string,
  overrides: Partial<InProcessTeammateTaskState> = {},
): InProcessTeammateTaskState {
  return {
    ...createTaskStateBase({
      id: `t-${agentName}`,
      type: "in_process_teammate",
      description: `${agentName}@${teamName}`,
      outputFile: "/tmp/x.out",
    }),
    type: "in_process_teammate",
    status: "running",
    identity: {
      agentId: `${agentName}@${teamName}`,
      agentName,
      teamName,
      agentType: "general-purpose",
    },
    prompt: "go",
    sessionFile: `/tmp/${agentName}.jsonl`,
    isIdle: true,
    pendingMessages: [],
    shutdownRequested: false,
    shutdownAcknowledged: false,
    toolCallCount: 0,
    tokenCount: 0,
    turnCount: 0,
    ...overrides,
  };
}

describe("renderTeamWidget", () => {
  it("empty teams → empty array", () => {
    expect(renderTeamWidget([], [])).toEqual([]);
  });

  it("single team with idle members", () => {
    const team: TeamState = {
      teamName: "research",
      createdAt: 1,
      memberAgentIds: ["alice@research", "bob@research"],
    };
    const tasks = [
      buildTask("alice", "research", { isIdle: true, turnCount: 2, tokenCount: 850 }),
      buildTask("bob", "research", { isIdle: true, turnCount: 1, tokenCount: 320 }),
    ];
    const lines = renderTeamWidget([team], tasks);
    expect(lines[0]).toMatch(/▶ research \(2 members\)/);
    expect(lines[1]).toContain("◌");
    expect(lines[1]).toContain("alice");
    expect(lines[1]).toContain("idle");
    expect(lines[1]).toContain("2 turns");
    expect(lines[1]).toContain("850 token");
    expect(lines[2]).toContain("bob");
  });

  it("running member shows ● + tool arrow", () => {
    const team: TeamState = {
      teamName: "engineering",
      createdAt: 1,
      memberAgentIds: ["coder@engineering"],
    };
    const tasks = [
      buildTask("coder", "engineering", {
        isIdle: false,
        lastTool: "bash",
        turnCount: 5,
        tokenCount: 2400,
      }),
    ];
    const lines = renderTeamWidget([team], tasks);
    expect(lines[1]).toContain("●");
    expect(lines[1]).toContain("coder");
    expect(lines[1]).toContain("→ bash");
    expect(lines[1]).toContain("2.4k token");
  });

  it("running member without lastTool shows 'working'", () => {
    const team: TeamState = {
      teamName: "t",
      createdAt: 1,
      memberAgentIds: ["x@t"],
    };
    const tasks = [
      buildTask("x", "t", { isIdle: false, turnCount: 1, tokenCount: 100 }),
    ];
    const lines = renderTeamWidget([team], tasks);
    expect(lines[1]).toContain("working");
  });

  it("singular 1 member / 1 turn / 1 token", () => {
    const team: TeamState = {
      teamName: "solo",
      createdAt: 1,
      memberAgentIds: ["one@solo"],
    };
    const tasks = [buildTask("one", "solo", { turnCount: 1, tokenCount: 1 })];
    const lines = renderTeamWidget([team], tasks);
    expect(lines[0]).toMatch(/\(1 member\)/);
    expect(lines[1]).toMatch(/1 turn,/);
    expect(lines[1]).toMatch(/1 token/);
  });

  it("missing teammate task → ✗ glyph + 'missing' text", () => {
    const team: TeamState = {
      teamName: "broken",
      createdAt: 1,
      memberAgentIds: ["ghost@broken"],
    };
    const lines = renderTeamWidget([team], []);
    expect(lines[1]).toContain("✗");
    expect(lines[1]).toContain("ghost");
    expect(lines[1]).toContain("missing");
  });

  it("terminal teammate task → ✗ glyph + status text", () => {
    const team: TeamState = {
      teamName: "broken",
      createdAt: 1,
      memberAgentIds: ["dead@broken"],
    };
    const tasks = [buildTask("dead", "broken", { status: "killed" })];
    const lines = renderTeamWidget([team], tasks);
    expect(lines[1]).toContain("✗");
    expect(lines[1]).toContain("killed");
  });

  it("two teams separated by blank line", () => {
    const teams: TeamState[] = [
      { teamName: "a", createdAt: 1, memberAgentIds: ["x@a"] },
      { teamName: "b", createdAt: 2, memberAgentIds: ["y@b"] },
    ];
    const tasks = [buildTask("x", "a"), buildTask("y", "b")];
    const lines = renderTeamWidget(teams, tasks);
    // First team header + 1 member + blank + Second team header + 1 member = 5
    expect(lines.length).toBe(5);
    expect(lines[0]).toContain("a");
    expect(lines[2]).toBe("");
    expect(lines[3]).toContain("b");
  });

  it("selectedAgentId matches a normal teammate → row prefix is '▶ '", () => {
    const team: TeamState = {
      teamName: "research",
      createdAt: 1,
      memberAgentIds: ["alice@research", "bob@research"],
    };
    const tasks = [
      buildTask("alice", "research", { isIdle: true, turnCount: 2, tokenCount: 850 }),
      buildTask("bob", "research", { isIdle: true, turnCount: 1, tokenCount: 320 }),
    ];
    const lines = renderTeamWidget([team], tasks, {
      selectedAgentId: "bob@research",
    });
    // alice is unselected → leading two-space indent.
    expect(lines[1]?.startsWith("  ◌ alice")).toBe(true);
    // bob is selected → leading "▶ ".
    expect(lines[2]?.startsWith("▶ ◌ bob")).toBe(true);
  });

  it("selectedAgentId matches a missing/terminal teammate → '▶ ' prefix", () => {
    const team: TeamState = {
      teamName: "broken",
      createdAt: 1,
      memberAgentIds: ["ghost@broken", "dead@broken"],
    };
    const tasks = [buildTask("dead", "broken", { status: "killed" })];
    const missingLines = renderTeamWidget([team], tasks, {
      selectedAgentId: "ghost@broken",
    });
    expect(missingLines[1]?.startsWith("▶ ✗ ghost")).toBe(true);
    expect(missingLines[2]?.startsWith("  ✗ dead")).toBe(true);

    const terminalLines = renderTeamWidget([team], tasks, {
      selectedAgentId: "dead@broken",
    });
    expect(terminalLines[1]?.startsWith("  ✗ ghost")).toBe(true);
    expect(terminalLines[2]?.startsWith("▶ ✗ dead")).toBe(true);
  });

  it("selectedAgentId does not match any teammate → all rows still '  '", () => {
    const team: TeamState = {
      teamName: "research",
      createdAt: 1,
      memberAgentIds: ["alice@research", "bob@research"],
    };
    const tasks = [
      buildTask("alice", "research"),
      buildTask("bob", "research"),
    ];
    const lines = renderTeamWidget([team], tasks, {
      selectedAgentId: "nobody@elsewhere",
    });
    expect(lines[1]?.startsWith("  ◌ alice")).toBe(true);
    expect(lines[2]?.startsWith("  ◌ bob")).toBe(true);
    expect(lines.some((l) => l.startsWith("▶ ◌"))).toBe(false);
  });

  it("selectedAgentId undefined (default) → identical to old API output", () => {
    const team: TeamState = {
      teamName: "research",
      createdAt: 1,
      memberAgentIds: ["alice@research"],
    };
    const tasks = [
      buildTask("alice", "research", { isIdle: true, turnCount: 2, tokenCount: 850 }),
    ];
    const baseline = renderTeamWidget([team], tasks);
    const explicitDefault = renderTeamWidget([team], tasks, {});
    const undefSelected = renderTeamWidget([team], tasks, {
      selectedAgentId: undefined,
    });
    expect(explicitDefault).toEqual(baseline);
    expect(undefSelected).toEqual(baseline);
    expect(baseline[1]?.startsWith("  ◌ alice")).toBe(true);
  });

  it("truncates long lines to width with ellipsis", () => {
    const team: TeamState = {
      teamName: "wide",
      createdAt: 1,
      memberAgentIds: ["x".repeat(200) + "@wide"],
    };
    const tasks = [
      buildTask("x".repeat(200), "wide", { turnCount: 99, tokenCount: 999_999 }),
    ];
    const lines = renderTeamWidget([team], tasks, { width: 40 });
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // At least one line truncated → contains ellipsis
    expect(lines.some((l) => l.endsWith("…"))).toBe(true);
  });
});
