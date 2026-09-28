import { describe, expect, it } from "vitest";
import { reviewOperationForTool, reviewRelativePath } from "./review-tools.js";

describe("review operation classification", () => {
  it("preserves unusual names and resolves paths from a subdirectory", () => {
    expect(reviewRelativePath("/repo", "/repo/sub", "../ 空\n名.ts")).toBe(" 空\n名.ts");
    expect(reviewOperationForTool("functions.edit", { path: "x.ts" }, "/repo", "/repo/sub")).toEqual({ paths: ["sub/x.ts"] });
  });
  it("does not accept outside paths or read-only tools", () => {
    expect(reviewRelativePath("/repo", "/repo", "../other/file")).toBeUndefined();
    for (const tool of ["read", "grep", "find", "ls", "task_status", "task_list"]) {
      expect(reviewOperationForTool(tool, { path: "a" }, "/repo", "/repo")).toBeUndefined();
    }
  });
  it("understands compatible path tools and write batches", () => {
    expect(reviewOperationForTool("cursor_edit", { file_path: "/repo/a" }, "/repo", "/repo")).toEqual({ paths: ["a"] });
    expect(reviewOperationForTool("multi_tool_use.parallel", { tool_uses: [
      { recipient_name: "functions.write", parameters: { path: "a" } },
      { recipient_name: "functions.edit", parameters: { path: "b" } },
      { recipient_name: "functions.read", parameters: { path: "c" } },
    ] }, "/repo", "/repo")).toEqual({ paths: ["a", "b"] });
  });
  it("opens a worktree window for shell and delegating operations", () => {
    for (const tool of ["bash", "task_bash", "async_bash", "task_agent", "send_message", "teammate_interrupt"]) {
      expect(reviewOperationForTool(tool, {}, "/repo", "/repo")).toEqual({});
    }
    expect(reviewOperationForTool("parallel", { tool_uses: [
      { recipient_name: "functions.bash", parameters: {} },
    ] }, "/repo", "/repo")).toEqual({});
  });
});
