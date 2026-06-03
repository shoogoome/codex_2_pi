import { describe, it, expect } from "vitest";
import { reduceTeammateEvents } from "./jsonlEvents.js";
import type { TeammateEvent, TeammateIdentity } from "./types.js";

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
    expect(state).toEqual({ teams: {}, teammates: {} });
  });
});
