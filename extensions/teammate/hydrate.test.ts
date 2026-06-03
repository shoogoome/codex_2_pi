import { describe, it, expect } from "vitest";
import { hydrateTeammateState, type SessionEntryLike } from "./hydrate.js";
import { TEAMMATE_EVENT_CUSTOM_TYPE } from "./eventEmit.js";
import type { TeammateEvent } from "./types.js";

const t1id = {
  agentId: "r@t1",
  agentName: "r",
  teamName: "t1",
  agentType: "general-purpose",
};

describe("hydrateTeammateState", () => {
  it("empty entries → empty state", () => {
    const state = hydrateTeammateState([]);
    expect(state).toEqual({ teams: {}, teammates: {} });
  });

  it("rebuilds from team_create + teammate_spawn events", () => {
    const events: TeammateEvent[] = [
      { kind: "team_create", teamName: "t1", description: "ds", createdAt: 100 },
      {
        kind: "teammate_spawn",
        identity: t1id,
        sessionFile: "/tmp/r.jsonl",
        initialPrompt: "go",
      },
    ];
    const entries: SessionEntryLike[] = events.map((e) => ({
      type: "custom_message",
      customType: TEAMMATE_EVENT_CUSTOM_TYPE,
      details: e,
    }));
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teammates["r@t1"]?.lastStatus).toBe("running");
  });

  it("ignores entries with wrong customType", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "custom_message",
        customType: "tasks/notification", // not ours
        details: { kind: "team_create", teamName: "t1", createdAt: 1 },
      },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t2", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teams["t2"]).toBeDefined();
  });

  it("ignores non-custom_message entries", () => {
    const entries: SessionEntryLike[] = [
      { type: "message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: { kind: "team_create", teamName: "t1", createdAt: 1 } },
      { type: "session" },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t2", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeUndefined();
    expect(state.teams["t2"]).toBeDefined();
  });

  it("silently skips malformed details (no kind / not object)", () => {
    const entries: SessionEntryLike[] = [
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: undefined },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: "not-an-object" },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: {} },
      { type: "custom_message", customType: TEAMMATE_EVENT_CUSTOM_TYPE, details: { kind: 42 } },
      // valid one for sanity
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t1", createdAt: 1 },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
  });

  it("replays full lifecycle: spawn → terminal → team_delete", () => {
    const entries: SessionEntryLike[] = [
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "team_create", teamName: "t1", createdAt: 1 },
      },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: {
          kind: "teammate_spawn",
          identity: t1id,
          sessionFile: "/tmp/r.jsonl",
          initialPrompt: "go",
        },
      },
      {
        type: "custom_message",
        customType: TEAMMATE_EVENT_CUSTOM_TYPE,
        details: { kind: "teammate_terminal", agentId: "r@t1", status: "completed" },
      },
    ];
    const state = hydrateTeammateState(entries);
    expect(state.teams["t1"]).toBeDefined();
    expect(state.teammates["r@t1"]?.lastStatus).toBe("completed");
  });
});
