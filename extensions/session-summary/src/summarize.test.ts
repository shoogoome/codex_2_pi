import {
  buildAgentSummarySource,
  buildContextualAgentSummarySource,
  buildUserSummarySource,
  cleanModelSummary,
  fallbackAgentSummary,
  fallbackUserSummary,
} from "./summarize.js";

describe("session summary extraction", () => {
  it("builds a bounded agent digest from user/assistant text and tool names only", () => {
    const source = buildAgentSummarySource([
      { role: "user", content: [{ type: "text", text: "实现会话摘要" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我会先检查扩展 API" },
          { type: "toolCall", name: "read", arguments: { path: "/secret/file" } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "SECRET_SHOULD_NOT_BE_INCLUDED" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "已实现并通过测试" },
          { type: "toolCall", name: "read", arguments: {} },
          { type: "toolCall", name: "edit", arguments: {} },
        ],
      },
    ]);

    expect(source).toContain("用户目标：实现会话摘要");
    expect(source).toContain("Agent 输出：已实现并通过测试");
    expect(source).toContain("调用过的工具：read、edit");
    expect(source).not.toContain("SECRET_SHOULD_NOT_BE_INCLUDED");
    expect(source).not.toContain("/secret/file");
  });

  it("adds only the configured recent turns as context for user summaries", () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "第一轮" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "第一轮结果" }] } },
      { type: "message", message: { role: "user", content: [{ type: "text", text: "第二轮" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "第二轮结果" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "SECRET" }] } },
    ];

    const source = buildUserSummarySource("把它继续优化", branch, 1);
    expect(source).toContain("第二轮");
    expect(source).toContain("第二轮结果");
    expect(source).toContain("当前用户消息：\n把它继续优化");
    expect(source).not.toContain("第一轮结果");
    expect(source).not.toContain("SECRET");
    expect(buildUserSummarySource("不带上下文", branch, 0)).toBe("不带上下文");
  });

  it("does not duplicate the current turn in agent context", () => {
    const current = [
      { role: "user", content: [{ type: "text", text: "当前需求" }] },
      { role: "assistant", content: [{ type: "text", text: "当前完成结果" }] },
    ];
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "上一轮需求" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "上一轮结果" }] } },
      ...current.map((message) => ({ type: "message", message })),
    ];

    const source = buildContextualAgentSummarySource(current, branch, 1);
    expect(source).toContain("上一轮需求");
    expect(source.match(/当前需求/g)).toHaveLength(1);
    expect(source.match(/当前完成结果/g)).toHaveLength(1);
  });

  it("uses the final assistant text or error as the immediate fallback", () => {
    expect(fallbackAgentSummary([
      { role: "assistant", content: [{ type: "text", text: "先检查" }] },
      { role: "assistant", content: [{ type: "text", text: "最后完成" }] },
    ])).toBe("最后完成");

    expect(fallbackAgentSummary([
      { role: "assistant", content: [], errorMessage: "rate limited" },
    ])).toBe("本轮执行失败：rate limited");
  });

  it("cleans model decoration and keeps user fallback on one line", () => {
    expect(cleanModelSummary("```text\n用户：实现常驻摘要面板\n```"))
      .toBe("实现常驻摘要面板");
    expect(fallbackUserSummary("  第一行\n第二行 ")).toBe("第一行 第二行");
  });
});
