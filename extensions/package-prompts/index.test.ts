import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import packagePromptsExtension from "./index.js";
import { appendPackagePrompt, PACKAGE_APPEND_PROMPT, PACKAGE_PROMPT_RULES } from "./src/prompt.js";

describe("package-wide prompts", () => {
  it("centralizes independent orchestration rules with unique IDs", () => {
    expect(new Set(PACKAGE_PROMPT_RULES.map((rule) => rule.id)).size).toBe(PACKAGE_PROMPT_RULES.length);
    expect(PACKAGE_APPEND_PROMPT).toContain("一次 codemode");
    expect(PACKAGE_APPEND_PROMPT).toContain("Promise.allSettled");
    for (const tool of ["change_title", "set_session_name", "mcp__tmux_title__set_title"]) {
      expect(PACKAGE_APPEND_PROMPT).toContain(tool);
    }
    expect(PACKAGE_APPEND_PROMPT).toContain("只调用实际可用的工具");
    expect(PACKAGE_APPEND_PROMPT).toContain("每个工具仍可独立使用");
    expect(PACKAGE_APPEND_PROMPT).toContain("codemode 不可用时才分别调用");
    expect(PACKAGE_APPEND_PROMPT).toContain("后台 worker");
    expect(PACKAGE_APPEND_PROMPT).toContain("普通进度变化不重复命名");
  });

  it("prefers efficient codemode batching without unsafe parallelism", () => {
    const rule = PACKAGE_PROMPT_RULES.find((entry) => entry.id === "efficient-codemode")!;
    expect(rule.body).toContain("尽量使用 codemode");
    expect(rule.body).toContain("Promise.allSettled");
    expect(rule.body).toContain("按顺序执行");
    expect(rule.body).toContain("不必强行包装");
    expect(rule.body).toContain("审批边界");
  });

  it("delegates independent long work without blocking or recursive workers", () => {
    const rule = PACKAGE_PROMPT_RULES.find((entry) => entry.id === "nonblocking-localagent")!;
    for (const text of [
      "task_agent", "后台 LocalAgent", "验收条件", "共享文件边界",
      "只读规划限制", "叶子 worker", "不立即轮询 task_status",
      "结束当前回合", "自动完成通知", "检查产物与验证证据",
    ]) {
      expect(rule.body).toContain(text);
    }
  });

  it("preserves existing instructions and appends exactly once", () => {
    const base = "# Base\nExisting behavior and tool descriptions.";
    const result = appendPackagePrompt(base);
    expect(result).toBe(base + "\n\n" + PACKAGE_APPEND_PROMPT);
    expect(appendPackagePrompt(result)).toBe(result);
    expect(appendPackagePrompt("")).toContain(PACKAGE_APPEND_PROMPT);
  });

  it("only injects prompt policy without registering or invoking any tools", () => {
    const handlers = new Map<string, (event: any) => any>();
    const pi = {
      on: vi.fn((name: string, handler: (event: any) => any) => handlers.set(name, handler)),
      registerTool: vi.fn(),
      registerMcpServer: vi.fn(),
      sendMessage: vi.fn(),
    };
    packagePromptsExtension(pi as unknown as ExtensionAPI);
    expect([...handlers.keys()]).toEqual(["before_agent_start"]);
    const handler = handlers.get("before_agent_start")!;
    // Apply to user/custom runs without depending on a particular event version.
    for (const messageType of ["user", "custom", undefined]) {
      const event = { systemPrompt: "prior extension prompt", messageType };
      const result = handler(event);
      expect(result.systemPrompt).toBe(appendPackagePrompt(event.systemPrompt));
      expect(event.systemPrompt).toBe("prior extension prompt");
    }
    expect(pi.registerTool).not.toHaveBeenCalled();
    expect(pi.registerMcpServer).not.toHaveBeenCalled();
    expect(pi.sendMessage).not.toHaveBeenCalled();
  });

  it("has no shared mutable state across sessions or runtime instances", () => {
    const handlers: Array<(event: any) => any> = [];
    const pi = { on: (_name: string, handler: (event: any) => any) => { handlers.push(handler); } };
    packagePromptsExtension(pi as unknown as ExtensionAPI);
    packagePromptsExtension(pi as unknown as ExtensionAPI);
    expect(handlers[0]({ systemPrompt: "session A" }).systemPrompt).toBe(appendPackagePrompt("session A"));
    expect(handlers[1]({ systemPrompt: "session B" }).systemPrompt).toBe(appendPackagePrompt("session B"));
  });
});
