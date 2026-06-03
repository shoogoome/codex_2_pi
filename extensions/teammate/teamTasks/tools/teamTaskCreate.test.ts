import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamTaskCreateTool } from "./teamTaskCreate.js";
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

describe("team_task_create tool", () => {
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
  });

  it("creates a task in an existing team and emits team_task_create event", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    expect(tool.name).toBe("team_task_create");

    const result = await tool.execute(
      "c1",
      { team_name: "alpha", subject: "fix login bug" } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details.action).toBe("team_task_create");
    expect(result.details.taskId).toMatch(/^tt-[0-9a-f]{12}$/);
    expect(result.details.teamName).toBe("alpha");
    expect(result.details.subject).toBe("fix login bug");
    expect(result.details.blockedBy).toEqual([]);

    // Store has the task
    const tasks = handle.teamTaskStore.list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.subject).toBe("fix login bug");
    expect(tasks[0]!.status).toBe("pending");
    expect(tasks[0]!.teamName).toBe("alpha");
    expect(tasks[0]!.blockedBy).toEqual([]);
    expect(tasks[0]!.blocks).toEqual([]);

    // Event emitted via sendMessage
    const eventCalls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(eventCalls).toHaveLength(1);
    const eventDetails = (eventCalls[0]![0] as { details: { kind: string; task: unknown } })
      .details;
    expect(eventDetails.kind).toBe("team_task_create");
    expect(eventDetails.task).toEqual(tasks[0]);

    // Tool result text
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(result.details.taskId!);
    expect(text).toContain("alpha");
    expect(text).toContain("fix login bug");
    expect(text).toContain("(unowned)");
  });

  it("rejects empty team_name", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c2",
      { team_name: "   ", subject: "x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/team_name must be non-empty/);
    expect(handle.teamTaskStore.list()).toHaveLength(0);
  });

  it("rejects empty subject (after trim)", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c3",
      { team_name: "alpha", subject: "   " } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(/subject must be non-empty/);
    expect(handle.teamTaskStore.list()).toHaveLength(0);
  });

  it("rejects when team does not exist", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c4",
      { team_name: "ghost", subject: "x" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toMatch(
      /Team 'ghost' does not exist/,
    );
    expect(handle.teamTaskStore.list()).toHaveLength(0);
  });

  it("persists owner / description / blocked_by / metadata into the store", async () => {
    // Pre-create an upstream task to point blocked_by at.
    handle.teamTaskStore.createTask({
      id: "tt-upstream0001",
      teamName: "alpha",
      subject: "upstream",
      createdAt: 500,
    });

    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c5",
      {
        team_name: "alpha",
        subject: "downstream task",
        description: "Do the downstream thing.",
        owner: "alice",
        blocked_by: ["tt-upstream0001"],
        metadata: { priority: "high", tags: ["urgent"] },
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(result.details.owner).toBe("alice");
    expect(result.details.blockedBy).toEqual(["tt-upstream0001"]);

    const created = handle.teamTaskStore.getTask(result.details.taskId!);
    expect(created).toBeDefined();
    expect(created!.subject).toBe("downstream task");
    expect(created!.description).toBe("Do the downstream thing.");
    expect(created!.owner).toBe("alice");
    expect(created!.blockedBy).toEqual(["tt-upstream0001"]);
    expect(created!.metadata).toEqual({ priority: "high", tags: ["urgent"] });

    // Result text mentions owner.
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("alice");
    expect(text).toContain("tt-upstream0001");
  });

  it("leaves owner undefined when not supplied", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c6",
      { team_name: "alpha", subject: "unowned work" } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const created = handle.teamTaskStore.getTask(result.details.taskId!);
    expect(created!.owner).toBeUndefined();
    expect(result.details.owner).toBeUndefined();
  });

  it("syncs reverse blocks on existing upstream when blocked_by is supplied", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-upstream0002",
      teamName: "alpha",
      subject: "upstream2",
      createdAt: 600,
    });
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c7",
      {
        team_name: "alpha",
        subject: "downstream2",
        blocked_by: ["tt-upstream0002"],
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const upstream = handle.teamTaskStore.getTask("tt-upstream0002");
    expect(upstream!.blocks).toContain(result.details.taskId);
  });

  it("emits teammate/event customMessage with full task payload", async () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    const result = await tool.execute(
      "c8",
      {
        team_name: "alpha",
        subject: "with metadata",
        owner: "bob",
        metadata: { foo: "bar" },
      } as never,
      undefined as never,
      undefined,
      {} as never,
    );
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const eventCalls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) => (m as { customType?: string }).customType === "teammate/event",
    );
    expect(eventCalls).toHaveLength(1);
    const [msg, opts] = eventCalls[0]! as unknown as [
      { customType: string; content: string; display: boolean; details: { kind: string; task: { id: string; subject: string; owner?: string } } },
      { triggerTurn: boolean },
    ];
    expect(msg.customType).toBe("teammate/event");
    expect(msg.content).toBe("team_task_create");
    expect(msg.display).toBe(false);
    expect(opts.triggerTurn).toBe(false);
    expect(msg.details.kind).toBe("team_task_create");
    expect(msg.details.task.id).toBe(result.details.taskId);
    expect(msg.details.task.subject).toBe("with metadata");
    expect(msg.details.task.owner).toBe("bob");
  });

  it("description guides the LLM with assign-or-unowned + blocked_by semantics", () => {
    const tool = buildTeamTaskCreateTool(pi as never);
    expect(tool.description).toMatch(/team task/i);
    expect(tool.description).toMatch(/owner/);
    expect(tool.description).toMatch(/unowned/);
    expect(tool.description).toMatch(/blocked_by/);
    expect(tool.description).toMatch(/team_task_update/);
    expect(tool.description).toMatch(/pending/);
  });
});
