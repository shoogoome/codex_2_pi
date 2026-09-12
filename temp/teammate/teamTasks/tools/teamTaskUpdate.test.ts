import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamTaskUpdateTool } from "./teamTaskUpdate.js";
import { attachTeammateHandle, type TeammateHandle } from "../../handle.js";
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

function lastEvent(pi: FakePi): {
  msg: {
    customType: string;
    content: string;
    display: boolean;
    details: { kind: string; taskId: string; teamName: string; patch: Record<string, unknown>; updatedAt: number };
  };
  opts: { triggerTurn: boolean };
} {
  const calls = pi.sendMessage.mock.calls.filter(
    ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
  );
  const last = calls[calls.length - 1]!;
  return { msg: last[0] as never, opts: last[1] as never };
}

describe("team_task_update tool", () => {
  let pi: FakePi;
  let handle: TeammateHandle;

  beforeEach(() => {
    pi = buildPi();
    const teamStore = createTeamStore();
    const teamTaskStore = createTeamTaskStore();
    const mailbox = createMailbox();
    handle = { teamStore, mailbox, teamTaskStore };
    attachTeammateHandle(pi as never, handle);
    teamStore.createTeam("alpha", undefined, 1000);
    handle.teamTaskStore.createTask({
      id: "tt-base",
      teamName: "alpha",
      subject: "baseline",
      description: "baseline desc",
      owner: "alice",
      metadata: { priority: "med" },
      createdAt: 1000,
    });
  });

  it("happy: updates subject and emits team_task_update event", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    expect(tool.name).toBe("team_task_update");

    const result = await tool.execute(
      "c1",
      { task_id: "tt-base", subject: "new subject" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const stored = handle.teamTaskStore.getTask("tt-base");
    expect(stored!.subject).toBe("new subject");
    expect(stored!.owner).toBe("alice");

    const { msg, opts } = lastEvent(pi);
    expect(msg.customType).toBe("teammate/event");
    expect(msg.content).toBe("team_task_update");
    expect(msg.display).toBe(false);
    expect(opts.triggerTurn).toBe(false);
    expect(msg.details.kind).toBe("team_task_update");
    expect(msg.details.taskId).toBe("tt-base");
    expect(msg.details.teamName).toBe("alpha");
    expect(msg.details.patch).toEqual({ subject: "new subject" });
    expect(typeof msg.details.updatedAt).toBe("number");

    expect(result.details).toMatchObject({
      action: "team_task_update",
      taskId: "tt-base",
    });
  });

  it("updates status pending → in_progress", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c2",
      { task_id: "tt-base", status: "in_progress" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.status).toBe("in_progress");

    const { msg } = lastEvent(pi);
    expect(msg.details.patch).toEqual({ status: "in_progress" });
  });

  it("updates owner: assign new agentName", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c3",
      { task_id: "tt-base", owner: "bob" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.owner).toBe("bob");

    const { msg } = lastEvent(pi);
    expect(msg.details.patch).toEqual({ owner: "bob" });
  });

  it("updates owner: null → clears (unowned)", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c4",
      { task_id: "tt-base", owner: null } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const stored = handle.teamTaskStore.getTask("tt-base");
    expect(stored!.owner).toBeUndefined();

    // Result text should mention (unowned)
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("(unowned)");
  });

  it("updates description: null → clears", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c5",
      { task_id: "tt-base", description: null } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.description).toBeUndefined();
  });

  it("updates metadata: null → clears", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c6",
      { task_id: "tt-base", metadata: null } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.metadata).toBeUndefined();
  });

  it("replaces blocked_by wholesale; reverse blocks updated on upstream", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-up1",
      teamName: "alpha",
      subject: "upstream1",
      createdAt: 500,
    });
    handle.teamTaskStore.createTask({
      id: "tt-up2",
      teamName: "alpha",
      subject: "upstream2",
      createdAt: 500,
    });
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c7",
      { task_id: "tt-base", blocked_by: ["tt-up1", "tt-up2"] } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.blockedBy).toEqual([
      "tt-up1",
      "tt-up2",
    ]);
    // Reverse blocks synced by store.
    expect(handle.teamTaskStore.getTask("tt-up1")!.blocks).toContain("tt-base");
    expect(handle.teamTaskStore.getTask("tt-up2")!.blocks).toContain("tt-base");

    const { msg } = lastEvent(pi);
    expect(msg.details.patch).toEqual({ blockedBy: ["tt-up1", "tt-up2"] });

    // And clear with [] works.
    const cleared = await tool.execute(
      "c7b",
      { task_id: "tt-base", blocked_by: [] } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((cleared as { isError?: boolean }).isError).toBeFalsy();
    expect(handle.teamTaskStore.getTask("tt-base")!.blockedBy).toEqual([]);
  });

  it("returns isError when task_id does not exist", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c8",
      { task_id: "tt-ghost", subject: "x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Task 'tt-ghost' not found/,
    );
    // No event emitted.
    const calls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects empty task_id (after trim)", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c8b",
      { task_id: "   ", subject: "x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/task_id/);
  });

  it("no-op when no patch fields provided: returns current task without isError", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    const result = await tool.execute(
      "c9",
      { task_id: "tt-base" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    // Store unchanged.
    expect(handle.teamTaskStore.getTask("tt-base")!.subject).toBe("baseline");
    expect(handle.teamTaskStore.getTask("tt-base")!.owner).toBe("alice");
    // No event emitted (no patch fields).
    const calls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(calls).toHaveLength(0);
  });

  it("emits teammate/event with kind=team_task_update + correct patch fields", async () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    await tool.execute(
      "c10",
      {
        task_id: "tt-base",
        subject: "new s",
        status: "in_progress",
        owner: "bob",
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    const { msg } = lastEvent(pi);
    expect(msg.details.kind).toBe("team_task_update");
    expect(msg.details.taskId).toBe("tt-base");
    expect(msg.details.teamName).toBe("alpha");
    expect(msg.details.patch).toEqual({
      subject: "new s",
      status: "in_progress",
      owner: "bob",
    });
  });

  it("description guides the LLM on claim/done/release/blockers semantics", () => {
    const tool = buildTeamTaskUpdateTool(pi as never);
    expect(tool.description).toMatch(/Update a team task/i);
    expect(tool.description).toMatch(/owner/);
    expect(tool.description).toMatch(/in_progress/);
    expect(tool.description).toMatch(/completed/);
    expect(tool.description).toMatch(/blocked_by/);
    expect(tool.description).toMatch(/null/);
  });
});
