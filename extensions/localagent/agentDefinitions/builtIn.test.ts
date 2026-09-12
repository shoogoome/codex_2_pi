import { describe, expect, it } from "vitest";
import { FORK_AGENT, FORK_AGENT_TYPE } from "./builtIn.js";

describe("FORK_AGENT", () => {
  it("是 LocalAgent 唯一的内部模式", () => {
    expect(FORK_AGENT_TYPE).toBe("__fork__");
    expect(FORK_AGENT.agentType).toBe(FORK_AGENT_TYPE);
  });

  it("继承完整工具池但不追加角色 system prompt", () => {
    expect(FORK_AGENT.tools).toEqual(["*"]);
    expect(FORK_AGENT.systemPrompt).toBe("");
  });
});
