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

  it("pads output to fallback height (=200) so the overlay covers the full viewport", () => {
    const { deps } = buildDeps();
    const c = buildTeammateOverlayComponent(deps);
    const lines = c.render(80);
    expect(lines.length).toBe(200);
    // Trailing rows are empty strings (padding for full-screen coverage).
    expect(lines[lines.length - 1]).toBe("");
  });

  it("honours an explicit defaultHeight in deps", () => {
    const { deps } = buildDeps({ defaultHeight: 12 });
    const c = buildTeammateOverlayComponent(deps);
    const lines = c.render(80);
    expect(lines.length).toBe(12);
  });

  it("getHeight callback takes precedence over defaultHeight, called every render", () => {
    const getHeight = vi
      .fn<() => number>()
      .mockReturnValueOnce(60)
      .mockReturnValueOnce(80);
    const { deps } = buildDeps({ defaultHeight: 100, getHeight });
    const c = buildTeammateOverlayComponent(deps);
    // getHeight reports the TERMINAL height; the view reserves the input dock,
    // so the rendered row count is strictly smaller and tracks the terminal.
    const first = c.render(80).length;
    const second = c.render(80).length;
    expect(first).toBeLessThan(60);
    expect(second).toBeLessThan(80);
    expect(second).toBeGreaterThan(first);
    expect(getHeight).toHaveBeenCalledTimes(2);
  });

  it("sizes the view to reserve the input dock", () => {
    // The overlay is composited from the TOP of the frame while the editor dock
    // sits at the BOTTOM of the same frame, so a full-height overlay painted
    // over the input box — the user's typing went into an invisible editor.
    // Regression guard: a 45-row terminal must NOT yield a 45-row view.
    const { deps } = buildDeps({ getHeight: () => 45 });
    const c = buildTeammateOverlayComponent(deps);
    const lines = c.render(200);

    expect(lines.length).toBeLessThan(45);
    expect(lines.length).toBeGreaterThan(6);
  });

  it("forwards theme.fg into renderTeammateOverlay so output carries colour tokens", () => {
    const { deps } = buildDeps({
      theme: {
        fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      },
    });
    const c = buildTeammateOverlayComponent(deps);
    // Wide enough that the header's left/right split still fits; a narrower
    // terminal takes the single-colour truncate path by design.
    const lines = c.render(200);
    // Header label is painted accent.
    expect(lines[0]).toContain("<accent>▶ teammate:</accent>");
    // Body row [USER] uses accent colour.
    expect(lines.some((l) => l.includes("<accent>[USER]</accent>"))).toBe(true);
  });
});
