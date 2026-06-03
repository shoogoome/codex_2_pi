import { describe, it, expect } from "vitest";
import { isTeamTaskEvent, type TeamTask, type TeamTaskEvent } from "./types.js";
import type { TeammateEvent } from "../types.js";

const baseTask: TeamTask = {
  id: "tt-3akj9d2x",
  teamName: "t1",
  subject: "Investigate flake",
  status: "pending",
  blockedBy: [],
  blocks: [],
  createdAt: 100,
  updatedAt: 100,
};

describe("isTeamTaskEvent", () => {
  it("returns true for team_task_create / _update / _delete", () => {
    const create: TeamTaskEvent = { kind: "team_task_create", task: baseTask };
    const update: TeamTaskEvent = {
      kind: "team_task_update",
      taskId: baseTask.id,
      teamName: baseTask.teamName,
      patch: { status: "in_progress" },
      updatedAt: 200,
    };
    const del: TeamTaskEvent = {
      kind: "team_task_delete",
      taskId: baseTask.id,
      teamName: baseTask.teamName,
    };
    expect(isTeamTaskEvent(create)).toBe(true);
    expect(isTeamTaskEvent(update)).toBe(true);
    expect(isTeamTaskEvent(del)).toBe(true);
  });

  it("returns false for the original 7 TeammateEvent kinds", () => {
    const others: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "team_delete", teamName: "t1" },
      {
        kind: "teammate_spawn",
        identity: {
          agentId: "a@t1",
          agentName: "a",
          teamName: "t1",
          agentType: "general-purpose",
        },
        sessionFile: "/tmp/a.jsonl",
        initialPrompt: "go",
      },
      { kind: "teammate_terminal", agentId: "a@t1", status: "completed" },
      {
        kind: "message_sent",
        msg: {
          id: "m1",
          from: "leader",
          to: "a",
          body: "hi",
          timestamp: 100,
          isProtocol: false,
        },
      },
      { kind: "shutdown_request", agentId: "a@t1", requestId: "req-1" },
      {
        kind: "shutdown_response",
        agentId: "a@t1",
        requestId: "req-1",
        approve: true,
      },
    ];
    for (const e of others) {
      expect(isTeamTaskEvent(e)).toBe(false);
    }
  });

  it("returns true for hypothetical future team_task_* kinds", () => {
    // Future-proof: any kind starting with team_task_ narrows to TeamTaskEvent.
    // We don't actually extend the union; we cast a minimal stub to test the guard.
    const future = {
      kind: "team_task_archive",
      taskId: "tt-x",
      teamName: "t",
    } as unknown as TeammateEvent;
    expect(isTeamTaskEvent(future)).toBe(true);
  });

  it("TeamTask interface accepts optional fields and arrays", () => {
    const t: TeamTask = {
      id: "tt-x",
      teamName: "t1",
      subject: "subj",
      description: "long desc",
      status: "in_progress",
      owner: "leader",
      blockedBy: ["tt-a", "tt-b"],
      blocks: ["tt-c"],
      metadata: { foo: 1, bar: "baz" },
      createdAt: 1,
      updatedAt: 2,
    };
    expect(t.id).toBe("tt-x");
    expect(t.blockedBy).toHaveLength(2);
  });
});
