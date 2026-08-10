import { describe, expect, it } from "vitest";
import type { AgentDefinition } from "../localagent/types.js";
import { fingerprintAgentDefinition } from "./roleFingerprint.js";

const role: AgentDefinition = {
  agentType: "reviewer",
  whenToUse: "review code",
  tools: ["read", "grep"],
  disallowedTools: ["write"],
  source: "project",
  systemPrompt: "Review only.",
};

describe("fingerprintAgentDefinition", () => {
  it("is stable for an unchanged role and changes with its permission policy", () => {
    expect(fingerprintAgentDefinition(role)).toBe(
      fingerprintAgentDefinition({ ...role }),
    );
    expect(
      fingerprintAgentDefinition({ ...role, tools: ["*"] }),
    ).not.toBe(fingerprintAgentDefinition(role));
    expect(
      fingerprintAgentDefinition({ ...role, systemPrompt: "New policy" }),
    ).not.toBe(fingerprintAgentDefinition(role));
  });
});
