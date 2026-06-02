import { describe, it, expect } from "vitest";
import {
  GENERAL_PURPOSE_AGENT,
  EXPLORE_AGENT,
  FORK_AGENT,
  FORK_AGENT_TYPE,
  getBuiltInAgents,
} from "./builtIn.js";

describe("GENERAL_PURPOSE_AGENT", () => {
  it("agentType 是 'general-purpose'", () => {
    expect(GENERAL_PURPOSE_AGENT.agentType).toBe("general-purpose");
  });
  it("source 是 built-in", () => {
    expect(GENERAL_PURPOSE_AGENT.source).toBe("built-in");
  });
  it("tools 包含 read/grep/find/ls/bash/edit/write", () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toEqual(
      expect.arrayContaining(["read", "grep", "find", "ls", "bash", "edit", "write"]),
    );
  });
  it("systemPrompt 非空", () => {
    expect(GENERAL_PURPOSE_AGENT.systemPrompt.length).toBeGreaterThan(20);
  });
});

describe("EXPLORE_AGENT", () => {
  it("只读工具集", () => {
    expect(EXPLORE_AGENT.tools).toEqual(["read", "grep", "find", "ls"]);
  });
  it("agentType 是 'explore'", () => {
    expect(EXPLORE_AGENT.agentType).toBe("explore");
  });
});

describe("FORK_AGENT", () => {
  it("agentType 是 '__fork__'(内部名)", () => {
    expect(FORK_AGENT_TYPE).toBe("__fork__");
    expect(FORK_AGENT.agentType).toBe(FORK_AGENT_TYPE);
  });
  it("background=true", () => {
    expect(FORK_AGENT.background).toBe(true);
  });
  it("tools 是 ['*']", () => {
    expect(FORK_AGENT.tools).toEqual(["*"]);
  });
  it("systemPrompt 是空字符串(继承父)", () => {
    expect(FORK_AGENT.systemPrompt).toBe("");
  });
});

describe("getBuiltInAgents", () => {
  it("不含 FORK_AGENT(LLM 不可见)", () => {
    const list = getBuiltInAgents();
    expect(list.find((a) => a.agentType === "__fork__")).toBeUndefined();
  });
  it("包含 general-purpose 和 explore", () => {
    const list = getBuiltInAgents();
    expect(list.find((a) => a.agentType === "general-purpose")).toBeDefined();
    expect(list.find((a) => a.agentType === "explore")).toBeDefined();
  });
});
