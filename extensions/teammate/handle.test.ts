import { describe, it, expect, expectTypeOf } from "vitest";
import {
  attachTeammateHandle,
  createApprovalRequestRegistry,
  getTeammateHandle,
  type TeammateHandle,
} from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";
import { createTeamTaskStore, type TeamTaskStore } from "./teamTasks/teamTaskStore.js";

function buildPi(): { events: Record<string, unknown> } {
  return { events: {} };
}

function buildHandle(): TeammateHandle {
  return {
    teamStore: createTeamStore(),
    mailbox: createMailbox(),
    teamTaskStore: createTeamTaskStore(),
    approvalRequests: createApprovalRequestRegistry(),
  };
}

describe("teammate handle", () => {
  it("attach + get returns the same handle instance", () => {
    const pi = buildPi();
    const h: TeammateHandle = buildHandle();
    attachTeammateHandle(pi as never, h);
    expect(getTeammateHandle(pi as never)).toBe(h);
  });

  it("get without attach throws an informative error", () => {
    const pi = buildPi();
    expect(() => getTeammateHandle(pi as never)).toThrow(/teammate-extension/);
  });

  it("attach overwrites a previously-attached handle (re-attach idempotent)", () => {
    const pi = buildPi();
    const h1: TeammateHandle = buildHandle();
    const h2: TeammateHandle = buildHandle();
    attachTeammateHandle(pi as never, h1);
    attachTeammateHandle(pi as never, h2);
    expect(getTeammateHandle(pi as never)).toBe(h2);
  });

  it("round-trip exposes a usable teamTaskStore", () => {
    const pi = buildPi();
    const h: TeammateHandle = buildHandle();
    attachTeammateHandle(pi as never, h);
    const got = getTeammateHandle(pi as never);
    expect(got.teamTaskStore).toBeDefined();
    expect(got.teamTaskStore.get()).toEqual({});
    expect(typeof got.teamTaskStore.createTask).toBe("function");
  });

  it("TeammateHandle.teamTaskStore is typed as TeamTaskStore", () => {
    expectTypeOf<TeammateHandle["teamTaskStore"]>().toEqualTypeOf<TeamTaskStore>();
  });
});
