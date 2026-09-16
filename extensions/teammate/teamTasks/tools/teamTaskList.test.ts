import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTeamTaskListTool } from "./teamTaskList.js";
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

interface ListResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  details: {
    action: "team_task_list";
    count?: number;
    taskIds?: string[];
  };
}

async function runList(
  tool: ReturnType<typeof buildTeamTaskListTool>,
  params: Record<string, unknown>,
): Promise<ListResult> {
  return (await tool.execute(
    "c1",
    params as never,
    undefined as never,
    undefined,
    {} as never,
  )) as ListResult;
}

describe("team_task_list tool", () => {
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
    teamStore.createTeam("beta", undefined, 1100);

    // alpha team — 3 tasks, varying status / owner
    teamTaskStore.createTask({
      id: "tt-a-pend-alice",
      teamName: "alpha",
      subject: "alpha pending alice",
      owner: "alice",
      createdAt: 2000,
    });
    teamTaskStore.createTask({
      id: "tt-a-prog-unowned",
      teamName: "alpha",
      subject: "alpha in_progress unowned",
      createdAt: 2100,
    });
    teamTaskStore.updateTask("tt-a-prog-unowned", {
      status: "in_progress",
      updatedAt: 2200,
    });
    teamTaskStore.createTask({
      id: "tt-a-done-bob",
      teamName: "alpha",
      subject: "alpha completed bob",
      owner: "bob",
      createdAt: 2300,
    });
    teamTaskStore.updateTask("tt-a-done-bob", {
      status: "completed",
      updatedAt: 2400,
    });

    // beta team — 3 tasks, varying status / owner
    teamTaskStore.createTask({
      id: "tt-b-pend-unowned",
      teamName: "beta",
      subject: "beta pending unowned",
      createdAt: 2500,
    });
    teamTaskStore.createTask({
      id: "tt-b-prog-alice",
      teamName: "beta",
      subject: "beta in_progress alice",
      owner: "alice",
      createdAt: 2600,
    });
    teamTaskStore.updateTask("tt-b-prog-alice", {
      status: "in_progress",
      updatedAt: 2700,
    });
    teamTaskStore.createTask({
      id: "tt-b-done-unowned",
      teamName: "beta",
      subject: "beta completed unowned",
      createdAt: 2800,
    });
    teamTaskStore.updateTask("tt-b-done-unowned", {
      status: "completed",
      updatedAt: 2900,
    });
  });

  it("lists all tasks (no filter) in createdAt-ascending order", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    expect(tool.name).toBe("team_task_list");

    const result = await runList(tool, {});

    expect(result.isError).toBeFalsy();
    expect(result.details.action).toBe("team_task_list");
    expect(result.details.count).toBe(6);
    expect(result.details.taskIds).toEqual([
      "tt-a-pend-alice",
      "tt-a-prog-unowned",
      "tt-a-done-bob",
      "tt-b-pend-unowned",
      "tt-b-prog-alice",
      "tt-b-done-unowned",
    ]);
    const text = result.content[0]!.text;
    expect(text).toContain("Found 6 task(s)");
    expect(text).toContain("tt-a-pend-alice");
    expect(text).toContain("tt-b-done-unowned");
  });

  it("filters by team_name", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { team_name: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(3);
    expect(result.details.taskIds).toEqual([
      "tt-a-pend-alice",
      "tt-a-prog-unowned",
      "tt-a-done-bob",
    ]);
    const text = result.content[0]!.text;
    expect(text).not.toContain("tt-b-");
  });

  it("filters by status", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { status: "pending" });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(2);
    expect(result.details.taskIds).toEqual([
      "tt-a-pend-alice",
      "tt-b-pend-unowned",
    ]);
  });

  it("filters by owner exact name", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { owner: "alice" });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(2);
    expect(result.details.taskIds).toEqual([
      "tt-a-pend-alice",
      "tt-b-prog-alice",
    ]);
  });

  it("filters owner = '' as UNOWNED only", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { owner: "" });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(3);
    expect(result.details.taskIds).toEqual([
      "tt-a-prog-unowned",
      "tt-b-pend-unowned",
      "tt-b-done-unowned",
    ]);
    const text = result.content[0]!.text;
    expect(text).toContain("(unowned)");
  });

  it("does not filter owner when owner param is omitted", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { team_name: "alpha" });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(3);
    // includes both owned (alice/bob) and unowned tasks of alpha
    expect(result.details.taskIds).toContain("tt-a-pend-alice");
    expect(result.details.taskIds).toContain("tt-a-prog-unowned");
    expect(result.details.taskIds).toContain("tt-a-done-bob");
  });

  it("AND-combines multiple filters", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, {
      team_name: "alpha",
      status: "pending",
      owner: "alice",
    });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(1);
    expect(result.details.taskIds).toEqual(["tt-a-pend-alice"]);
  });

  it("returns 'No tasks match the filter.' when empty", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, {
      team_name: "alpha",
      status: "pending",
      owner: "bob",
    });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(0);
    expect(result.details.taskIds).toEqual([]);
    expect(result.content[0]!.text).toBe("No tasks match the filter.");
  });

  it("trims owner whitespace as exact match", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { owner: "   alice   " });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(2);
    expect(result.details.taskIds).toEqual([
      "tt-a-pend-alice",
      "tt-b-prog-alice",
    ]);
  });

  it("treats whitespace-only owner like '' (unowned only)", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { owner: "   " });

    expect(result.isError).toBeFalsy();
    expect(result.details.count).toBe(3);
    expect(result.details.taskIds).toEqual([
      "tt-a-prog-unowned",
      "tt-b-pend-unowned",
      "tt-b-done-unowned",
    ]);
  });

  it("truncates subject longer than 70 chars with '...' in the rendered text", async () => {
    handle.teamTaskStore.createTask({
      id: "tt-long-subject",
      teamName: "alpha",
      subject:
        "this is an extraordinarily verbose subject line that exceeds seventy characters by quite a bit",
      createdAt: 9000,
    });

    const tool = buildTeamTaskListTool(pi as never);
    const result = await runList(tool, { team_name: "alpha" });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("tt-long-subject");
    // Truncated marker present.
    expect(text).toContain("...");
    // Full long subject is NOT present verbatim.
    expect(text).not.toContain(
      "this is an extraordinarily verbose subject line that exceeds seventy characters by quite a bit",
    );
  });

  it("description guides LLM with three owner-mode semantics", () => {
    const tool = buildTeamTaskListTool(pi as never);
    expect(tool.description).toMatch(/team task/i);
    expect(tool.description).toMatch(/owner/);
    expect(tool.description).toMatch(/UNOWNED/);
    expect(tool.description).toMatch(/empty string/);
    expect(tool.description).toMatch(/AND/);
  });

  it("does NOT emit any teammate/event (read-only)", async () => {
    const tool = buildTeamTaskListTool(pi as never);
    await runList(tool, {});
    const eventCalls = pi.sendMessage.mock.calls.filter(
      ([m]: unknown[]) =>
        (m as { customType?: string }).customType === "teammate/event",
    );
    expect(eventCalls).toHaveLength(0);
  });
});
