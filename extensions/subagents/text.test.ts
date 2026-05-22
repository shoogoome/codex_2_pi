import { describe, expect, it } from "vitest";
import {
  buildAssistantPreview,
  createDefaultUsage,
  normalizeTaskName,
  previewJson,
  previewText,
  truncateMiddle,
} from "./text.js";

describe("subagent text helpers", () => {
  it("normalizes valid task names", () => {
    expect(normalizeTaskName(" Review_API ")).toBe("review_api");
    expect(normalizeTaskName("worker-1")).toBe("worker_1");
  });

  it("rejects invalid task names", () => {
    expect(() => normalizeTaskName("")).toThrow("task_name is required");
    expect(() => normalizeTaskName("a".repeat(65))).toThrow("task_name must be at most 64 characters");
    expect(() => normalizeTaskName("bad/name")).toThrow("task_name may contain only letters, digits, underscores, and hyphens");
  });

  it("truncates middle with byte-safe slices for short limits", () => {
    expect(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 12)).toBe("abcd…wxyz");
    expect(truncateMiddle("short", 12)).toBe("short");
  });

  it("previews text on one line", () => {
    expect(previewText("hello\n   world", 20)).toBe("hello world");
    expect(previewText("a".repeat(30), 10)).toBe("aaaa…aaaa");
  });

  it("previews JSON values", () => {
    expect(previewJson({ command: "npm test", nested: { ok: true } }, 80)).toContain("npm test");
  });

  it("creates default usage counters", () => {
    expect(createDefaultUsage()).toEqual({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  });

  it("builds assistant previews", () => {
    expect(buildAssistantPreview("done\nwith work")).toBe("done with work");
    expect(buildAssistantPreview(undefined)).toBeUndefined();
  });
});
