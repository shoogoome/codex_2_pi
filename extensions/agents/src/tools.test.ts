import { describe, expect, it } from "vitest";
import { parseToolWhitelist, resolveRoleTools } from "./tools.js";

describe("parseToolWhitelist", () => {
  it("returns undefined for undefined/null (not specified)", () => {
    expect(parseToolWhitelist(undefined)).toBeUndefined();
    expect(parseToolWhitelist(null)).toBeUndefined();
  });

  it("returns [] for an empty string (explicitly no tools)", () => {
    expect(parseToolWhitelist("")).toEqual([]);
    expect(parseToolWhitelist("   ")).toEqual([]);
  });

  it("splits a comma-separated string", () => {
    expect(parseToolWhitelist("read, grep ,ls")).toEqual(["read", "grep", "ls"]);
  });

  it("accepts a string array and dedupes", () => {
    expect(parseToolWhitelist(["read", "read", "write"])).toEqual(["read", "write"]);
  });

  it("keeps '*' as a marker", () => {
    expect(parseToolWhitelist("*")).toEqual(["*"]);
    expect(parseToolWhitelist(["*"])).toEqual(["*"]);
  });

  it("returns undefined for non-string arrays / wrong types", () => {
    expect(parseToolWhitelist([1, 2])).toBeUndefined();
    expect(parseToolWhitelist(42)).toBeUndefined();
  });
});

describe("resolveRoleTools", () => {
  const ALL = ["read", "grep", "find", "ls", "bash", "edit", "write", "task_agent", "agents"];

  it("uses safe read-only defaults when tools is undefined", () => {
    expect(resolveRoleTools({ tools: undefined }, ALL)).toEqual(["read", "grep", "find", "ls"]);
  });

  it("expands '*' to all registered tools (minus never-include)", () => {
    const r = resolveRoleTools({ tools: ["*"] }, ALL);
    expect(r).toContain("bash");
    expect(r).toContain("write");
    expect(r).not.toContain("task_agent");
    expect(r).not.toContain("agents");
  });

  it("uses an explicit list as-is", () => {
    expect(resolveRoleTools({ tools: ["read", "grep"] }, ALL)).toEqual(["read", "grep"]);
  });

  it("returns [] for an explicit empty list", () => {
    expect(resolveRoleTools({ tools: [] }, ALL)).toEqual([]);
  });

  it("applies the disallowedTools blacklist", () => {
    const r = resolveRoleTools({ tools: ["read", "write", "bash"], disallowedTools: ["write"] }, ALL);
    expect(r).toEqual(["read", "bash"]);
  });

  it("always strips task_agent and agents", () => {
    const r = resolveRoleTools({ tools: ["read", "task_agent", "agents"] }, ALL);
    expect(r).toEqual(["read"]);
  });
});
