import { applyCoordinatorPolicy } from "./agentWorkflowPolicy.js";
import { EXPLICIT_MULTI_AGENT_MODE_PROMPT, ULTRA_WORKFLOW_PROMPT } from "../ultra/core.js";
it("normalizes coordinator mode regardless of previous explicit/Ultra blocks", () => {
  const before = "base\n\n" + EXPLICIT_MULTI_AGENT_MODE_PROMPT + "\n\n" + ULTRA_WORKFLOW_PROMPT;
  const result = applyCoordinatorPolicy(before, { enabled: true, effective: "active" });
  expect(result.match(/<multi_agent_mode>/g)).toHaveLength(1);
  expect(result).not.toContain("Do not spawn sub-agents unless");
  expect(result).not.toContain("<ultra_multi_agent_workflow>");
  expect(applyCoordinatorPolicy(result, { enabled: true, effective: "active" })).toBe(result);
  const off = applyCoordinatorPolicy(result, { enabled: false, effective: "off" });
  expect(off.trim()).toBe("base");
  expect(applyCoordinatorPolicy(before, { enabled: false, effective: "off" })).toBe(before);
});
it("worker identity and pause cannot be converted into active coordination", () => {
  const coordinator = applyCoordinatorPolicy("base", { enabled: true, effective: "active" });
  const worker = applyCoordinatorPolicy(coordinator, { enabled: true, effective: "active", worker: true });
  expect(worker).toContain("not the coordinator");
  expect(worker).not.toContain("Use coordinator_task");
  expect(worker).not.toContain("<multi_agent_mode>");
  const paused = applyCoordinatorPolicy(coordinator, { enabled: true, effective: "paused-plan" });
  expect(paused).toContain("paused-plan");
  expect(paused).not.toContain("Use coordinator_task");
});
