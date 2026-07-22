import { describe, expect, it } from "vitest";
import {
  EXPLORE_ROLE,
  PLAN_ROLE,
  GENERAL_PURPOSE_ROLE,
  VERIFICATION_ROLE,
  getBuiltInRoles,
} from "./builtIn.js";
import { validateRole } from "./validate.js";

const WRITE_TOOLS = ["write", "edit"];

describe("built-in roles", () => {
  it("exposes the four expected roles, all built-in source", () => {
    const roles = getBuiltInRoles();
    const names = roles.map((r) => r.agentType);
    expect(names).toEqual(["explore", "plan", "general-purpose", "verification"]);
    expect(roles.every((r) => r.source === "built-in")).toBe(true);
  });

  it("Explore and Plan are read-only (no write/edit tools)", () => {
    for (const r of [EXPLORE_ROLE, PLAN_ROLE]) {
      expect(r.tools).toBeDefined();
      for (const w of WRITE_TOOLS) expect(r.tools).not.toContain(w);
    }
  });

  it("verification is read-only for source (no write/edit)", () => {
    for (const w of WRITE_TOOLS) expect(VERIFICATION_ROLE.tools).not.toContain(w);
  });

  it("general-purpose includes write tools", () => {
    expect(GENERAL_PURPOSE_ROLE.tools).toContain("write");
    expect(GENERAL_PURPOSE_ROLE.tools).toContain("edit");
  });

  it("every built-in role is non-empty and passes validateRole", () => {
    for (const r of getBuiltInRoles()) {
      expect(r.systemPrompt.length).toBeGreaterThan(20);
      const v = validateRole(r);
      expect(v.isValid).toBe(true);
    }
  });
});
