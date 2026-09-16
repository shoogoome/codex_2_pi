import { describe, it, expect } from "vitest";
import {
  buildTeammateBoilerplate,
  prependBoilerplate,
} from "./teammatePromptBoilerplate.js";
import type { TeammateIdentity } from "./types.js";

const identity: TeammateIdentity = {
  agentId: "alice@research",
  agentName: "alice",
  teamName: "research",
  agentType: "general-purpose",
};

describe("buildTeammateBoilerplate", () => {
  it("interpolates teamName and agentName into the boilerplate", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("research");
    expect(b).toContain("alice");
  });

  it("explains the cooperation contract via the 重要约定 section", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("重要约定");
  });

  it("instructs the teammate to call request_plan_approval before mutating actions", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("request_plan_approval");
  });

  it("references send_message as the cooperative escape hatch", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("send_message");
    // Must mention `to:"leader"` as the routing hint.
    expect(b).toContain("\"leader\"");
  });

  it("explains that tools are role-scoped instead of universally granting mutation", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("agent role");
    expect(b).toContain("general-purpose");
    expect(b).toContain("explore");
    expect(b).toContain("不要假设未列出的工具可用");
  });

  it("still documents approval for roles that have mutating tools", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("write / edit");
    expect(b).toContain("request_plan_approval");
  });

  it("includes an anti-hallucination disclaimer telling the LLM not to call the `mcp` tool", () => {
    // Real-world failure: the teammate LLM was hallucinating `mcp({search:"bash"})`
    // when it couldn't find a tool named `bash` (because localshell hid it).
    // The boilerplate must explicitly suppress that.
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("mcp");
  });
});

describe("prependBoilerplate", () => {
  it("places the boilerplate before the original prompt", () => {
    const original = "Investigate the authentication code.";
    const out = prependBoilerplate(original, identity);
    const boilerplate = buildTeammateBoilerplate(identity);
    expect(out.startsWith(boilerplate)).toBe(true);
    expect(out.endsWith(original)).toBe(true);
  });

  it("preserves the original prompt verbatim", () => {
    const original = "Line 1\n\nLine 2 with **markdown**\n  - bullet";
    const out = prependBoilerplate(original, identity);
    expect(out).toContain(original);
  });

  it("works with an empty prompt", () => {
    const out = prependBoilerplate("", identity);
    expect(out).toBe(buildTeammateBoilerplate(identity));
  });
});
