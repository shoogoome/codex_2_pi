import { describe, it, expect } from "vitest";
import { mergeAgentDefinitions, getAgentDefinition } from "./resolve.js";
import type { AgentDefinition } from "../types.js";

const builtIn: AgentDefinition = {
  agentType: "x",
  whenToUse: "B",
  tools: ["read"],
  source: "built-in",
  systemPrompt: "built-in",
};
const user: AgentDefinition = {
  agentType: "x",
  whenToUse: "U",
  tools: ["read", "grep"],
  source: "user",
  systemPrompt: "user",
};
const project: AgentDefinition = {
  agentType: "x",
  whenToUse: "P",
  tools: ["read", "grep", "find"],
  source: "project",
  systemPrompt: "project",
};

describe("mergeAgentDefinitions", () => {
  it("project > user > built-in 的覆盖优先级", () => {
    const merged = mergeAgentDefinitions([builtIn], [user], [project]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.systemPrompt).toBe("project");
    expect(merged[0]!.tools).toEqual(["read", "grep", "find"]);
  });

  it("user 覆盖 built-in,无 project", () => {
    const merged = mergeAgentDefinitions([builtIn], [user], []);
    expect(merged[0]!.systemPrompt).toBe("user");
  });

  it("不同 agentType 都保留", () => {
    const a: AgentDefinition = { ...builtIn, agentType: "a" };
    const b: AgentDefinition = { ...user, agentType: "b" };
    const merged = mergeAgentDefinitions([a], [b], []);
    expect(merged.map((d) => d.agentType).sort()).toEqual(["a", "b"]);
  });
});

describe("getAgentDefinition", () => {
  it("找到的 agent 直接返回", () => {
    const r = getAgentDefinition([builtIn], "x");
    expect(r).toBe(builtIn);
  });
  it("找不到返回 undefined", () => {
    expect(getAgentDefinition([builtIn], "nope")).toBeUndefined();
  });
});
