import { describe, it, expect } from "vitest";
import { parseAgentMarkdown, type ParseAgentResult } from "./frontmatter.js";

describe("parseAgentMarkdown", () => {
  it("正常 markdown:frontmatter + body 全部进 AgentDefinition", () => {
    const md = `---
agentType: explorer
whenToUse: Use for exploring codebases.
tools: [read, grep]
disallowedTools: [bash]
model: opus
background: false
maxTurns: 50
description: An eager codebase explorer.
---
You are an explorer. Find relevant code.`;
    const result = parseAgentMarkdown(md, "user", "explorer.md") as Extract<ParseAgentResult, { ok: true }>;
    expect(result.ok).toBe(true);
    expect(result.def.agentType).toBe("explorer");
    expect(result.def.whenToUse).toBe("Use for exploring codebases.");
    expect(result.def.tools).toEqual(["read", "grep"]);
    expect(result.def.disallowedTools).toEqual(["bash"]);
    expect(result.def.model).toBe("opus");
    expect(result.def.background).toBe(false);
    expect(result.def.maxTurns).toBe(50);
    expect(result.def.systemPrompt).toBe("You are an explorer. Find relevant code.");
    expect(result.def.source).toBe("user");
    expect(result.def.filename).toBe("explorer.md");
  });

  it("缺 agentType → 报错", () => {
    const md = `---
whenToUse: x
---
body`;
    const r = parseAgentMarkdown(md, "user", "bad.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/agentType/);
  });

  it("缺 whenToUse → 报错", () => {
    const md = `---
agentType: foo
---
body`;
    const r = parseAgentMarkdown(md, "user", "bad.md");
    expect(r.ok).toBe(false);
  });

  it("无 frontmatter → 报错", () => {
    const r = parseAgentMarkdown("plain text", "user", "x.md");
    expect(r.ok).toBe(false);
  });

  it("未知 model 字符串 → 报错", () => {
    const md = `---
agentType: a
whenToUse: x
model: gpt-4
---
body`;
    const r = parseAgentMarkdown(md, "user", "x.md");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/model/i);
  });

  it("body 为空 → systemPrompt 是空字符串(允许)", () => {
    const md = `---
agentType: a
whenToUse: x
---
`;
    const r = parseAgentMarkdown(md, "user", "x.md");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.def.systemPrompt).toBe("");
  });

  it("未列字段(criticalSystemReminder 等)被忽略,不报错", () => {
    const md = `---
agentType: a
whenToUse: x
criticalSystemReminder_EXPERIMENTAL: ignored
hooks: ignored
---
body`;
    const r = parseAgentMarkdown(md, "project", "a.md");
    expect(r.ok).toBe(true);
  });

  it("source=project 时,def.source=project", () => {
    const md = `---
agentType: a
whenToUse: x
---
b`;
    const r = parseAgentMarkdown(md, "project", "x.md");
    if (r.ok) expect(r.def.source).toBe("project");
  });
});
