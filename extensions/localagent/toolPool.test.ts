import { describe, it, expect } from "vitest";
import { resolveSubAgentTools } from "./toolPool.js";
import type { AgentDefinition } from "./types.js";

const base: AgentDefinition = {
  agentType: "x",
  whenToUse: "x",
  source: "built-in",
  systemPrompt: "",
};

describe("resolveSubAgentTools", () => {
  it("无 tools 字段 → 默认只读 [read,grep,find,ls]", () => {
    expect(resolveSubAgentTools(base, ["read", "grep", "find", "ls", "bash"])).toEqual([
      "read", "grep", "find", "ls",
    ]);
  });

  it("tools=['*'] → 用 allRegistered", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["*"] }, ["read", "bash", "task_bash"]),
    ).toEqual(["read", "bash", "task_bash"]);
  });

  it("显式 tools → 用 tools", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["read", "bash"] }, ["read", "grep", "bash", "edit"]),
    ).toEqual(["read", "bash"]);
  });

  it("disallowedTools 把 tools 里的剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "bash", "edit"], disallowedTools: ["bash"] },
        ["read", "bash", "edit"],
      ),
    ).toEqual(["read", "edit"]);
  });

  it("永远剔除 task_agent — 即使 agentDef.tools 显式包含也剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "task_agent", "grep"] },
        ["read", "task_agent", "grep"],
      ),
    ).toEqual(["read", "grep"]);
  });

  it("永远剔除 task_agent — 即使是 * 展开也剔除", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["*"] }, ["read", "task_agent"]),
    ).toEqual(["read"]);
  });

  it("disallowed 优先级高于 tools — bash 在两边都出现也剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "bash"], disallowedTools: ["bash"] },
        ["read", "bash"],
      ),
    ).toEqual(["read"]);
  });

  it("空 allRegistered + ['*'] → 空数组", () => {
    expect(resolveSubAgentTools({ ...base, tools: ["*"] }, [])).toEqual([]);
  });
});
