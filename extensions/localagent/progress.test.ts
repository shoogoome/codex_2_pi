import { describe, it, expect, beforeEach } from "vitest";
import {
  initProgress,
  recordToolStart,
  setTokens,
  getProgress,
  removeProgress,
  _resetProgressForTest,
} from "./progress.js";

beforeEach(() => {
  _resetProgressForTest();
});

describe("progress", () => {
  it("initProgress 初始化全 0", () => {
    initProgress("a1", 1000);
    const p = getProgress("a1")!;
    expect(p.toolCallCount).toBe(0);
    expect(p.tokenCount).toBe(0);
    expect(p.startTime).toBe(1000);
    expect(p.recentToolNames).toEqual([]);
  });

  it("recordToolStart 增加 toolCallCount + 推 recentToolNames(最多 5)", () => {
    initProgress("a1", 0);
    for (let i = 0; i < 7; i++) recordToolStart("a1", `tool_${i}`);
    const p = getProgress("a1")!;
    expect(p.toolCallCount).toBe(7);
    expect(p.recentToolNames).toEqual(["tool_2", "tool_3", "tool_4", "tool_5", "tool_6"]);
  });

  it("setTokens 取最新值(cumulative usage 语义)", () => {
    initProgress("a1", 0);
    setTokens("a1", 100);
    expect(getProgress("a1")!.tokenCount).toBe(100);
    setTokens("a1", 150);
    expect(getProgress("a1")!.tokenCount).toBe(150);
  });

  it("removeProgress 清掉条目", () => {
    initProgress("a1", 0);
    removeProgress("a1");
    expect(getProgress("a1")).toBeUndefined();
  });

  it("init 已存在的 task → 保留旧值不重置", () => {
    initProgress("a1", 0);
    setTokens("a1", 50);
    initProgress("a1", 100);
    expect(getProgress("a1")!.tokenCount).toBe(50);
    expect(getProgress("a1")!.startTime).toBe(0);
  });

  it("不存在的 task 调 recordToolStart / setTokens 安全(no-op)", () => {
    expect(() => recordToolStart("nope", "x")).not.toThrow();
    expect(() => setTokens("nope", 10)).not.toThrow();
    expect(getProgress("nope")).toBeUndefined();
  });
});
