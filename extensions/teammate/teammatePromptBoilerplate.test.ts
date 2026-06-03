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

  it("explains the missing write-class tools (bash / write / edit) intentionally", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("没有 bash / write / edit");
  });

  it("references send_message as the cooperative escape hatch", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("send_message");
    // Must mention `to:"leader"` as the routing hint.
    expect(b).toContain("\"leader\"");
  });

  it("describes the read-only tool surface still available", () => {
    const b = buildTeammateBoilerplate(identity);
    expect(b).toContain("read");
    expect(b).toContain("find");
    expect(b).toContain("grep");
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
