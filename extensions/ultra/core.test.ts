import { describe, expect, it } from "vitest";
import {
  EXPLICIT_MULTI_AGENT_MODE_PROMPT,
  ULTRA_WORKFLOW_PROMPT,
  applyUltraReasoningEffort,
  isUltraCapableModel,
  resolveUltraNativeEffort,
  getUltraWorkflowState,
  toolsForUltraTaskAgentActivation,
  upsertUltraWorkflowPrompt,
} from "./core.js";

describe("Codex Ultra model semantics", () => {
  const model = {
    provider: "openai-codex",
    api: "openai-codex-responses",
    id: "gpt-5.6-sol",
  };

  it("recognizes only Codex Responses models", () => {
    expect(isUltraCapableModel(model)).toBe(true);
    expect(isUltraCapableModel({ ...model, api: "openai-completions" })).toBe(false);
    expect(isUltraCapableModel({ ...model, provider: "other" })).toBe(false);
  });

  it("resolves the highest supported native effort like Codex", () => {
    expect(resolveUltraNativeEffort({ ...model, thinkingLevelMap: { max: "max" } })).toBe("max");
    expect(resolveUltraNativeEffort({ ...model, thinkingLevelMap: { xhigh: "xhigh" } })).toBe("xhigh");
  });

  it("adds the resolved effort without mutating the provider payload", () => {
    const payload = { model: model.id, input: [] };
    const result = applyUltraReasoningEffort(payload, model) as Record<string, unknown>;
    expect(result).toEqual({ ...payload, reasoning_effort: "max" });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(applyUltraReasoningEffort(result, model)).toBe(result);
  });
});

describe("Ultra workflow prompt", () => {
  it("upserts one idempotent workflow block", () => {
    const once = upsertUltraWorkflowPrompt("base", true);
    const twice = upsertUltraWorkflowPrompt(once, true);

    expect(twice).toBe(once);
    expect(twice.match(/<ultra_multi_agent_workflow>/g)).toHaveLength(1);
    expect(twice).toContain(ULTRA_WORKFLOW_PROMPT);
    expect(twice).toContain("multiple task_agent calls in parallel in a single assistant message");
    expect(twice).toContain("runs in background automatically");
    expect(twice).toContain("inherits its provider/model configuration");
    expect(twice).toContain("Do not poll forked agents");
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

    expect(getUltraWorkflowState(active, available, true)).toBe("paused-plan-mode");
    expect(toolsForUltraTaskAgentActivation(active, available, true)).toBeUndefined();
  });
});
