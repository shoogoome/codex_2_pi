import { describe, expect, it } from "vitest";
import { validateAgentType, validateRole } from "./validate.js";
import type { AgentRole } from "./types.js";

function role(overrides: Partial<AgentRole> = {}): AgentRole {
  return {
    agentType: "helper",
    whenToUse: "Helps with a variety of tasks in the repo",
    tools: ["read", "grep"],
    source: "user",
    systemPrompt: "You are a helpful assistant that does useful things.",
    ...overrides,
  };
}

describe("validateAgentType", () => {
  it("accepts a normal name", () => {
    expect(validateAgentType("code-reviewer").isValid).toBe(true);
  });

  it("rejects names that are too short or too long", () => {
    expect(validateAgentType("ab").isValid).toBe(false);
    expect(validateAgentType("a".repeat(51)).isValid).toBe(false);
  });

  it("rejects names with bad boundaries or characters", () => {
    expect(validateAgentType("-abc").isValid).toBe(false);
    expect(validateAgentType("abc-").isValid).toBe(false);
    expect(validateAgentType("a b c").isValid).toBe(false);
    expect(validateAgentType("").isValid).toBe(false);
  });
});

describe("validateRole", () => {
  it("passes a well-formed role", () => {
    const r = validateRole(role());
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("errors on an invalid name", () => {
    const r = validateRole(role({ agentType: "-x" }));
    expect(r.isValid).toBe(false);
  });

  it("errors on a missing description and warns on a short one", () => {
    expect(validateRole(role({ whenToUse: "" })).isValid).toBe(false);
    const shortD = validateRole(role({ whenToUse: "short" }));
    expect(shortD.isValid).toBe(true);
    expect(shortD.warnings.some((w) => /description/.test(w))).toBe(true);
  });

  it("errors on a too-short systemPrompt", () => {
    const r = validateRole(role({ systemPrompt: "too short" }));
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /systemPrompt/.test(e))).toBe(true);
  });

  it("warns on unknown tools when availableTools is supplied", () => {
    const r = validateRole(role({ tools: ["read", "banana"] }), ["read", "grep"]);
    expect(r.warnings.some((w) => /banana/.test(w))).toBe(true);
  });

  it("warns on a cross-source name conflict", () => {
    const existing = [role({ source: "project" })];
    const r = validateRole(role({ source: "user" }), undefined, existing);
    expect(r.warnings.some((w) => /also defined by source/.test(w))).toBe(true);
  });
});
