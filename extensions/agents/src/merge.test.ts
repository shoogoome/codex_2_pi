import { describe, expect, it } from "vitest";
import { mergeRoles, dedupeByRealpath, getRole, type RealpathEntry } from "./merge.js";
import type { AgentRole } from "./types.js";

function role(agentType: string, source: AgentRole["source"], extra: Partial<AgentRole> = {}): AgentRole {
  return {
    agentType,
    whenToUse: `use ${agentType}`,
    source,
    systemPrompt: `prompt for ${agentType}`,
    ...extra,
  };
}

describe("mergeRoles", () => {
  it("project overrides user overrides built-in on agentType", () => {
    const builtIn = [role("shared", "built-in"), role("only-builtin", "built-in")];
    const user = [role("shared", "user"), role("only-user", "user")];
    const project = [role("shared", "project")];
    const merged = mergeRoles(builtIn, user, project);
    expect(getRole(merged, "shared")?.source).toBe("project");
    expect(getRole(merged, "only-user")?.source).toBe("user");
    expect(getRole(merged, "only-builtin")?.source).toBe("built-in");
    expect(merged).toHaveLength(3);
  });
});

describe("dedupeByRealpath", () => {
  it("keeps the highest-priority source for a shared realpath", () => {
    const entries: RealpathEntry[] = [
      { role: role("dup", "user"), realpath: "/real/dup.md" },
      { role: role("dup", "project"), realpath: "/real/dup.md" },
    ];
    const out = dedupeByRealpath(entries);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe("project");
  });

  it("keeps distinct realpaths separate", () => {
    const entries: RealpathEntry[] = [
      { role: role("a", "user"), realpath: "/real/a.md" },
      { role: role("b", "project"), realpath: "/real/b.md" },
    ];
    expect(dedupeByRealpath(entries)).toHaveLength(2);
  });

  it("passes through entries with an empty realpath", () => {
    const entries: RealpathEntry[] = [
      { role: role("x", "built-in"), realpath: "" },
      { role: role("y", "built-in"), realpath: "" },
    ];
    expect(dedupeByRealpath(entries)).toHaveLength(2);
  });
});

describe("getRole", () => {
  it("finds by agentType and returns undefined when absent", () => {
    const defs = [role("a", "user"), role("b", "user")];
    expect(getRole(defs, "b")?.agentType).toBe("b");
    expect(getRole(defs, "missing")).toBeUndefined();
  });
});
