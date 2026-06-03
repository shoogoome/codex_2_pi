import { describe, it, expect } from "vitest";
import { attachTeammateHandle, getTeammateHandle, type TeammateHandle } from "./handle.js";
import { createTeamStore } from "./teamStore.js";
import { createMailbox } from "./mailbox.js";

function buildPi(): { events: Record<string, unknown> } {
  return { events: {} };
}

describe("teammate handle", () => {
  it("attach + get returns the same handle instance", () => {
    const pi = buildPi();
    const h: TeammateHandle = { teamStore: createTeamStore(), mailbox: createMailbox() };
    attachTeammateHandle(pi as never, h);
    expect(getTeammateHandle(pi as never)).toBe(h);
  });

  it("get without attach throws an informative error", () => {
    const pi = buildPi();
    expect(() => getTeammateHandle(pi as never)).toThrow(/teammate-extension/);
  });

  it("attach overwrites a previously-attached handle (re-attach idempotent)", () => {
    const pi = buildPi();
    const h1: TeammateHandle = { teamStore: createTeamStore(), mailbox: createMailbox() };
    const h2: TeammateHandle = { teamStore: createTeamStore(), mailbox: createMailbox() };
    attachTeammateHandle(pi as never, h1);
    attachTeammateHandle(pi as never, h2);
    expect(getTeammateHandle(pi as never)).toBe(h2);
  });
});
