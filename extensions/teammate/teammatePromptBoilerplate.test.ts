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

  it("acknowledges the teammate has full tool access (bash/write/edit) — no longer claims they're blocked", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("bash");
    expect(b).toContain("write");
    expect(b).toContain("edit");
    // Negative: must NOT contain the old "你没有 bash" boilerplate.
    expect(b).not.toContain("没有 bash");
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
