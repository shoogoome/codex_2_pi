// Tests for buildTeammateOverlayComponent — adapter that turns the pure
// renderTeammateOverlay into a Pi-TUI Component, lazily opening the
// teammate's session jsonl on first render.

import { describe, it, expect, vi } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildTeammateOverlayComponent,
  type TeammateOverlayDeps,
} from "./teammateOverlayComponent.js";

function userEntry(text: string, id = "u1"): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-06-04T00:00:00Z",
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: 0,
    },
  } as never;
}

function buildDeps(
  overrides?: Partial<TeammateOverlayDeps>,
): {
  deps: TeammateOverlayDeps;
  openSessionMock: ReturnType<typeof vi.fn>;
  getEntriesMock: ReturnType<typeof vi.fn>;
  getTaskHeaderMock: ReturnType<typeof vi.fn>;
} {
  const getEntriesMock = vi.fn(() => [userEntry("hello")] as SessionEntry[]);
  const openSessionMock = vi.fn(() => ({ getEntries: getEntriesMock }));
  const getTaskHeaderMock = vi.fn(() => ({ taskCount: 1, isIdle: false }));
  const deps: TeammateOverlayDeps = {
    identity: {
      agentId: "alice@team1",
      agentName: "alice",
      teamName: "team1",
      agentType: "general-purpose",
    },
    sessionFile: "/tmp/alice.jsonl",
    getTaskHeader: getTaskHeaderMock,
    openSession: openSessionMock as never,
    ...overrides,
  };
  return { deps, openSessionMock, getEntriesMock, getTaskHeaderMock };
}

describe("buildTeammateOverlayComponent", () => {
  it("returns a Component with render/invalidate/dispose", () => {
    const { deps } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    expect(typeof c.render).toBe("function");
    expect(typeof c.invalidate).toBe("function");
    expect(typeof c.dispose).toBe("function");
  });

  it("render calls openSession(sessionFile) and getEntries", () => {
    const { deps, openSessionMock, getEntriesMock } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    const lines = c.render(80);
    expect(openSessionMock).toHaveBeenCalledWith("/tmp/alice.jsonl");
    expect(getEntriesMock).toHaveBeenCalled();
    expect(lines.some((l) => l.includes("hello"))).toBe(true);
    // header includes alice
    expect(lines[0]).toContain("alice@team1");
  });

  it("subsequent render does NOT re-open the session (cached)", () => {
    const { deps, openSessionMock } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    c.render(80);
    c.render(80);
    c.render(80);
    expect(openSessionMock).toHaveBeenCalledTimes(1);
  });

  it("dispose clears the cached SessionManager — next render re-opens", () => {
    const { deps, openSessionMock } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    c.render(80);
    expect(openSessionMock).toHaveBeenCalledTimes(1);
    c.dispose();
    c.render(80);
    expect(openSessionMock).toHaveBeenCalledTimes(2);
  });

  it("render reads getTaskHeader fresh each call (turnCount/isIdle)", () => {
    const { deps, getTaskHeaderMock } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    c.render(80);
    c.render(80);
    expect(getTaskHeaderMock).toHaveBeenCalledTimes(2);
    // Header reflects the live values returned by getTaskHeader.
    getTaskHeaderMock.mockReturnValueOnce({ taskCount: 99, isIdle: true });
    const lines = c.render(80);
    expect(lines[0]).toContain("99");
    expect(lines[0]).toContain("idle");
  });
});
