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

  it("contains the D2 Path B write-class tools", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("bash")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("write")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("edit")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("task_bash")).toBe(true);
    expect(TEAMMATE_TOOLS_BLOCKLIST.has("task_kill")).toBe(true);
  });

  it("has exactly 8 entries — recursion guards (3) + write-class (5)", () => {
    expect(TEAMMATE_TOOLS_BLOCKLIST.size).toBe(8);
  });
});

describe("filterTeammateTools", () => {
  it("returns empty array for empty input", () => {
    expect(filterTeammateTools([])).toEqual([]);
  });

  it("removes every blocklisted tool from a fully-blocked input", () => {
    const all = [
      "task_agent",
      "team_create",
      "team_delete",
      "bash",
      "write",
      "edit",
      "task_bash",
      "task_kill",
    ];
    expect(filterTeammateTools(all)).toEqual([]);
  });

  it("keeps non-blocked tools untouched and removes blocked ones", () => {
    const mixed = [
      "read",
      "grep",
      "bash",
      "find",
      "task_agent",
      "send_message",
      "edit",
      "ls",
    ];
    expect(filterTeammateTools(mixed)).toEqual([
      "read",
      "grep",
      "find",
      "send_message",
      "ls",
    ]);
  });

  it("preserves input order of surviving tools", () => {
    const ordered = ["alpha", "bash", "beta", "edit", "gamma"];
    expect(filterTeammateTools(ordered)).toEqual(["alpha", "beta", "gamma"]);
  });
});
