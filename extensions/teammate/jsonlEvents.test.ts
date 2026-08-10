import { describe, it, expect } from "vitest";
import { reduceTeammateEvents } from "./jsonlEvents.js";
import type { TeammateEvent, TeammateIdentity } from "./types.js";
import type { TeamTask } from "./teamTasks/types.js";

const t1id: TeammateIdentity = {
  agentId: "r@t1",
  agentName: "r",
  teamName: "t1",
  agentType: "general-purpose",
};
const t2id: TeammateIdentity = {
  agentId: "c@t1",
  agentName: "c",
  teamName: "t1",
  agentType: "general-purpose",
};

describe("reduceTeammateEvents", () => {
  it("rebuilds team + members from event sequence", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", description: "ds", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "go" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teams["t1"]!.memberAgentIds).toEqual(["r@t1"]);
    expect(state.teammates["r@t1"]).toBeDefined();
    expect(state.teammates["r@t1"]!.lastStatus).toBe("running");
  });

  it("teammate_terminal flips status to killed", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "teammate_terminal", agentId: "r@t1", status: "killed" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teammates["r@t1"]!.lastStatus).toBe("killed");
  });

  it("team_delete removes team and marks members terminal", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "teammate_spawn", identity: t2id, sessionFile: "/tmp/c.jsonl", initialPrompt: "y" },
      { kind: "team_delete", teamName: "t1" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teammates["r@t1"]!.lastStatus).toBe("killed");
    expect(state.teammates["c@t1"]!.lastStatus).toBe("killed");
  });

  it("idempotent — same teammate_spawn twice does not duplicate memberAgentIds", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teams["t1"]!.memberAgentIds).toEqual(["r@t1"]);
  });

  it("teammate_terminal on unknown agent is a no-op", () => {
    const events: TeammateEvent[] = [
      { kind: "teammate_terminal", agentId: "ghost@nope", status: "killed" },
    ];
    const state = reduceTeammateEvents(events);
    expect(state.teammates).toEqual({});
  });

  it("message_sent / shutdown_request / shutdown_response do not change state", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "x" },
      {
        kind: "message_sent",
        msg: {
          id: "m1",
          from: "leader",
          to: "r",
          body: "hi",
          timestamp: 100,
          isProtocol: false,
        },
      },
      { kind: "shutdown_request", agentId: "r@t1", requestId: "req-1" },
      {
        kind: "shutdown_response",
        agentId: "r@t1",
        requestId: "req-1",
        approve: true,
      },
    ];
    const state = reduceTeammateEvents(events);
    // Teammate still running — only teammate_terminal flips status.
    expect(state.teammates["r@t1"]!.lastStatus).toBe("running");
  });

  it("persists canonical peer messages until the matching recipient ACK", () => {
    const msg = {
      id: "m-durable",
      from: "leader",
      to: "r@t1",
      body: "resume me",
      timestamp: 101,
      isProtocol: false,
    } as const;
    const pending = reduceTeammateEvents([
      { kind: "message_sent", msg },
      { kind: "message_sent", msg },
    ]);
    expect(pending.pendingMessages).toEqual({ "m-durable": msg });

    const wrongAck = reduceTeammateEvents([
      { kind: "message_sent", msg },
      { kind: "message_ack", messageId: msg.id, agentId: "other@t1" },
    ]);
    expect(wrongAck.pendingMessages).toEqual({ "m-durable": msg });

    const acknowledged = reduceTeammateEvents([
      { kind: "message_sent", msg },
      { kind: "message_ack", messageId: msg.id, agentId: "r@t1" },
    ]);
    expect(acknowledged.pendingMessages).toEqual({});
  });

  it("re-running reducer on same prefix yields same final state", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", createdAt: 1 },
      { kind: "teammate_spawn", identity: t1id, sessionFile: "/tmp/r.jsonl", initialPrompt: "go" },
    ];
    const a = reduceTeammateEvents(events);
    const b = reduceTeammateEvents(events);
    expect(a).toEqual(b);
  });

  it("empty event list yields empty state", () => {
    const state = reduceTeammateEvents([]);
    expect(state).toEqual({
      teams: {},
      teammates: {},
      teamTasks: {},
      pendingMessages: {},
    });
  });

  describe("team_task_* events", () => {
    const baseTask: TeamTask = {
      id: "tt-1",
      teamName: "t1",
      subject: "investigate",
      status: "pending",
      blockedBy: [],
      blocks: [],
      createdAt: 100,
      updatedAt: 100,
    };

    it("team_task_create adds task to teamTasks slice", () => {
      const events: TeammateEvent[] = [
        { kind: "team_task_create", task: baseTask },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks["tt-1"]).toEqual(baseTask);
    });

    it("team_task_update applies patch and updates updatedAt", () => {
      const events: TeammateEvent[] = [
        { kind: "team_task_create", task: baseTask },
        {
          kind: "team_task_update",
          taskId: "tt-1",
          teamName: "t1",
          patch: { status: "in_progress", owner: "leader" },
          updatedAt: 200,
        },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks["tt-1"]!.status).toBe("in_progress");
      expect(state.teamTasks["tt-1"]!.owner).toBe("leader");
      expect(state.teamTasks["tt-1"]!.updatedAt).toBe(200);
      // Untouched fields remain.
      expect(state.teamTasks["tt-1"]!.subject).toBe("investigate");
      expect(state.teamTasks["tt-1"]!.createdAt).toBe(100);
    });

    it("team_task_update replaces array fields wholesale (no merge)", () => {
      const taskWithDeps: TeamTask = {
        ...baseTask,
        blockedBy: ["tt-a", "tt-b"],
        blocks: ["tt-c"],
      };
      const events: TeammateEvent[] = [
        { kind: "team_task_create", task: taskWithDeps },
        {
          kind: "team_task_update",
          taskId: "tt-1",
          teamName: "t1",
          patch: { blockedBy: ["tt-x"] },
          updatedAt: 200,
        },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks["tt-1"]!.blockedBy).toEqual(["tt-x"]);
      // `blocks` was not in the patch, so it stays.
      expect(state.teamTasks["tt-1"]!.blocks).toEqual(["tt-c"]);
    });

    it("team_task_update on unknown task is a no-op", () => {
      const events: TeammateEvent[] = [
        {
          kind: "team_task_update",
          taskId: "tt-ghost",
          teamName: "t1",
          patch: { status: "completed" },
          updatedAt: 200,
        },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks).toEqual({});
    });

    it("team_task_delete removes the task", () => {
      const events: TeammateEvent[] = [
        { kind: "team_task_create", task: baseTask },
        { kind: "team_task_delete", taskId: "tt-1", teamName: "t1" },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks["tt-1"]).toBeUndefined();
    });

    it("team_task_delete on unknown task is a no-op", () => {
      const events: TeammateEvent[] = [
        { kind: "team_task_delete", taskId: "tt-ghost", teamName: "t1" },
      ];
      const state = reduceTeammateEvents(events);
      expect(state.teamTasks).toEqual({});
    });

    it("team_task slice is independent of teams / teammates slices", () => {
      const events: TeammateEvent[] = [
        { kind: "team_create", teamName: "t1", createdAt: 1 },
        {
          kind: "teammate_spawn",
          identity: t1id,
          sessionFile: "/tmp/r.jsonl",
          initialPrompt: "go",
        },
        { kind: "team_task_create", task: baseTask },
        {
          kind: "team_task_update",
          taskId: "tt-1",
          teamName: "t1",
          patch: { status: "completed" },
          updatedAt: 300,
        },
      ];
      const state = reduceTeammateEvents(events);
      // Team/teammate side untouched by team_task events.
      expect(state.teams["t1"]).toBeDefined();
      expect(state.teams["t1"]!.memberAgentIds).toEqual(["r@t1"]);
      expect(state.teammates["r@t1"]!.lastStatus).toBe("running");
      // teamTasks slice carries the patched task.
      expect(state.teamTasks["tt-1"]!.status).toBe("completed");
      expect(state.teamTasks["tt-1"]!.updatedAt).toBe(300);
    });
  });
});
