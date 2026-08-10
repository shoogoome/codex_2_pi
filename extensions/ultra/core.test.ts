import { describe, expect, it } from "vitest";
import {
  EXPLICIT_MULTI_AGENT_MODE_PROMPT,
  ULTRA_WORKFLOW_PROMPT,
  getUltraWorkflowState,
  toolsForUltraTaskAgentActivation,
  upsertUltraWorkflowPrompt,
} from "./core.js";

describe("Ultra workflow prompt", () => {
  it("upserts one idempotent workflow block", () => {
    const once = upsertUltraWorkflowPrompt("base", true);
    const twice = upsertUltraWorkflowPrompt(once, true);

    expect(twice).toBe(once);
    expect(twice.match(/<ultra_multi_agent_workflow>/g)).toHaveLength(1);
    expect(twice).toContain(ULTRA_WORKFLOW_PROMPT);
    expect(twice).toContain("multiple task_agent calls in parallel in a single assistant message");
    expect(twice).toContain("`run_in_background: true`");
    expect(twice).toContain("Do not poll teammates");
  });

  it("removes only the Ultra workflow block when inactive", () => {
    const base = `base\n\n${EXPLICIT_MULTI_AGENT_MODE_PROMPT}`;
    const active = upsertUltraWorkflowPrompt(base, true);

    expect(upsertUltraWorkflowPrompt(active, false)).toBe(base);
  });
});

describe("Ultra task_agent activation planning", () => {
  it("adds an installed inactive task_agent without changing other tools", () => {
    expect(toolsForUltraTaskAgentActivation(
      ["read", "grep"],
      ["read", "grep", "task_agent"],
    )).toEqual(["read", "grep", "task_agent"]);
  });

  it("does not bypass plan mode's read-only tool gate", () => {
    const active = ["read", "exit_plan_mode"];
    const available = ["read", "exit_plan_mode", "task_agent"];

    expect(getUltraWorkflowState(active, available)).toBe("paused-plan-mode");
    expect(toolsForUltraTaskAgentActivation(active, available)).toBeUndefined();
  });
});
