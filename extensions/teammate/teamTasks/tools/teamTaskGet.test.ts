import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamTaskGetTool } from "./teamTaskGet.js";
import { attachTeammateHandle, type TeammateHandle, createApprovalRequestRegistry } from "../../handle.js";
import { createTeamStore } from "../../teamStore.js";
import { createMailbox } from "../../mailbox.js";
import { createTeamTaskStore } from "../teamTaskStore.js";

interface FakePi {
  events: Record<string, unknown>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function buildPi(): FakePi {
  return { events: {}, sendMessage: vi.fn() };
}

describe("team_task_get tool", () => {
  let pi: FakePi;
  let handle: TeammateHandle;

  beforeEach(() => {
    pi = buildPi();
    const teamStore = createTeamStore();
    const teamTaskStore = createTeamTaskStore();
    const mailbox = createMailbox();
    handle = { teamStore, mailbox, teamTaskStore, approvalRequests: createApprovalRequestRegistry() };
    attachTeammateHandle(pi as never, handle);
    teamStore.createTeam("alpha", undefined, 1000);
  });

  it("returns full task details for an existing task", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-aaa",
      teamName: "alpha",
      subject: "fix login bug",
      createdAt: 1717459200000, // 2024-06-04T00:00:00.000Z (timestamp)
    });

    const tool = buildTeamTaskGetTool(pi as never);
    expect(tool.name).toBe("team_task_get");

    const result = await tool.execute(
      "c1",
      { task_id: "tt-aaa" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Task tt-aaa");
    expect(text).toContain("alpha");
    expect(text).toContain("fix login bug");
    expect(text).toContain("pending");
    // ISO timestamp
    expect(text).toContain(new Date(1717459200000).toISOString());
    // details payload contains full task
    expect(result.details.action).toBe("team_task_get");
    expect(result.details.task!.id).toBe("tt-aaa");
    expect(result.details.task!.subject).toBe("fix login bug");
    expect(result.details.task!.teamName).toBe("alpha");
  });

  it("rejects empty task_id", async () => {
    const tool = buildTeamTaskGetTool(pi as never);
    const result = await tool.execute(
      "c2",
      { task_id: "   " } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /task_id must be non-empty/,
    );
  });

  it("returns isError when task not found", async () => {
    const tool = buildTeamTaskGetTool(pi as never);
    const result = await tool.execute(
      "c3",
      { task_id: "tt-x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Task 'tt-x' not found/,
    );
  });

  it("renders all rich fields (description, metadata, owner, blocked_by, blocks)", async () => {
    // Pre-create upstream + downstream so blocks/blockedBy materialise.
    handle.teamTaskStore.createTask({
      id: "tt-bbb",
      teamName: "alpha",
      subject: "upstream",
      createdAt: 1700000000000,
    });
    handle.teamTaskStore.createTask({
      id: "tt-ccc",
      teamName: "alpha",
      subject: "upstream2",
      createdAt: 1700000001000,
    });
    handle.teamTaskStore.createTask({
      id: "tt-main",
      teamName: "alpha",
      subject: "main work",
      description: "Detailed description text.",
      owner: "alice",
      blockedBy: ["tt-bbb", "tt-ccc"],
      metadata: { priority: "high" },
      createdAt: 1717459200000,
    });
    // Downstream depending on tt-main → reverse-pointer fills tt-main.blocks.
    handle.teamTaskStore.createTask({
      id: "tt-ddd",
      teamName: "alpha",
      subject: "downstream",
      blockedBy: ["tt-main"],
      createdAt: 1717459300000,
    });
    handle.teamTaskStore.updateTask("tt-main", {
      status: "in_progress",
      updatedAt: 1717462825000,
    });

    const tool = buildTeamTaskGetTool(pi as never);
    const result = await tool.execute(
      "c4",
      { task_id: "tt-main" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Task tt-main");
    expect(text).toContain("alpha");
    expect(text).toContain("main work");
    expect(text).toContain("Detailed description text.");
    expect(text).toContain("in_progress");
    expect(text).toContain("alice");
    expect(text).toContain("tt-bbb");
    expect(text).toContain("tt-ccc");
    expect(text).toContain("tt-ddd");
    expect(text).toContain("priority");
    expect(text).toContain("high");
    expect(text).toContain(new Date(1717459200000).toISOString());
    expect(text).toContain(new Date(1717462825000).toISOString());

    expect(result.details.task!.id).toBe("tt-main");
    expect(result.details.task!.description).toBe("Detailed description text.");
    expect(result.details.task!.metadata).toEqual({ priority: "high" });
    expect(result.details.task!.blockedBy).toEqual(["tt-bbb", "tt-ccc"]);
    expect(result.details.task!.blocks).toEqual(["tt-ddd"]);
    expect(result.details.task!.owner).toBe("alice");
  });

  it("renders (none) for absent description / owner / metadata", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-min",
      teamName: "alpha",
      subject: "minimal task",
      createdAt: 1717459200000,
    });

    const tool = buildTeamTaskGetTool(pi as never);
    const result = await tool.execute(
      "c5",
      { task_id: "tt-min" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    // When optional fields are absent, render "(none)" — never literal "undefined".
    expect(text).not.toContain("undefined");
    expect(text).toMatch(/description:\s*\(none\)/);
    expect(text).toMatch(/owner:\s*\(none\)/);
    expect(text).toMatch(/metadata:\s*\(none\)/);
    // Empty arrays render as []
    expect(text).toMatch(/blocked_by:\s*\[\]/);
    expect(text).toMatch(/blocks:\s*\[\]/);
  });

  it("does NOT emit any teammate/event customMessage (read-only tool)", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-readonly",
      teamName: "alpha",
      subject: "no event",
      createdAt: 1717459200000,
    });
    const tool = buildTeamTaskGetTool(pi as never);
    await tool.execute(
      "c6",
      { task_id: "tt-readonly" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const eventCalls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(eventCalls).toHaveLength(0);
  });

  it("description guides LLM to use it as full-detail vs team_task_list truncated view", () => {
    const tool = buildTeamTaskGetTool(pi as never);
    expect(tool.description).toMatch(/team_task_list/);
    expect(tool.description).toMatch(/full/i);
  });
});
