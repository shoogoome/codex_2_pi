import { describe, it, expect } from "vitest";
import {
  TEAMMATE_TOOLS_BLOCKLIST,
  filterTeammateTools,
} from "./teammateToolPool.js";

describe("TEAMMATE_TOOLS_BLOCKLIST", () => {
  it("contains the D1 recursion guards", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("task_agent")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("team_create")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("team_delete")).toBe(true);
  });

  it("does NOT block write-class tools (bash/write/edit/task_bash/task_kill) — teammate has full execution access, gated by request_plan_approval", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("bash")).toBe(false);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("write")).toBe(false);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("edit")).toBe(false);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("task_bash")).toBe(false);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("task_kill")).toBe(false);
  });

  it("blocks teammate_interrupt — a teammate must not abort another teammate's turn", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("teammate_interrupt")).toBe(true);
  });

  it("has exactly 4 entries — 3 recursion guards + the leader-only interrupt", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.size).toBe(4);
  });
});

describe("filterTeammateTools", () => {
  it("returns empty array for empty input", () => {
    expect(filterTeammateTools([])).toEqual([]);
  });

  it("removes only the recursion guards from a fully-input set", () => {
    const all = [
      "task_agent",
      "team_create",
      "team_delete",
      "teammate_interrupt",
      "bash",
      "write",
      "edit",
      "task_bash",
      "task_kill",
    ];
    expect(filterTeammateTools(all)).toEqual([
      "bash",
      "write",
      "edit",
      "task_bash",
      "task_kill",
    ]);
  });

  it("keeps write-class tools (bash/write/edit/task_bash/task_kill) untouched", () => {
    const tools = ["bash", "write", "edit", "task_bash", "task_kill"];
    expect(filterTeammateTools(tools)).toEqual([
      "bash",
      "write",
      "edit",
      "task_bash",
      "task_kill",
    ]);
  });

  it("keeps non-blocked tools untouched and removes recursion guards", () => {
    const mixed = [
      "read",
      "grep",
      "bash",
      "find",
      "task_agent",
      "send_message",
      "teammate_interrupt",
      "edit",
      "ls",
    ];
    expect(filterTeammateTools(mixed)).toEqual([
      "read",
      "grep",
      "bash",
      "find",
      "send_message",
      "edit",
      "ls",
    ]);
  });

  it("preserves input order of surviving tools", () => {
    const ordered = ["alpha", "task_agent", "beta", "team_create", "gamma"];
    expect(filterTeammateTools(ordered)).toEqual(["alpha", "beta", "gamma"]);
  });
});
