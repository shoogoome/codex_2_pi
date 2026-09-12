import { describe, expect, it } from "vitest";
import { resolveForkTools } from "./toolPool.js";

describe("resolveForkTools", () => {
  it("继承主会话活动工具", () => {
    expect(resolveForkTools(["read", "grep", "bash", "edit"])).toEqual([
      "read",
      "grep",
      "bash",
      "edit",
    ]);
  });

  it("永远剔除 task_agent 防止递归 fork", () => {
    expect(resolveForkTools(["read", "task_agent", "grep"])).toEqual(["read", "grep"]);
  });

  it("空工具池保持为空", () => {
    expect(resolveForkTools([])).toEqual([]);
  });
});
