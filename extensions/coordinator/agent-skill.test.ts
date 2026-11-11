import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// Use the installed host loader to verify actual skill discovery/frontmatter.
const { loadSkillsFromDir, formatSkillsForPrompt } = await import(new URL(
  "../../node_modules/@earendil-works/pi-coding-agent/dist/core/skills.js",
  import.meta.url,
).href);

const root = new URL("../../", import.meta.url);
const prompt = readFileSync(new URL("skills/agent/SKILL.md", root), "utf8");
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));

function includesAll(values: string[]) {
  for (const value of values) expect(prompt).toContain(value);
}

describe("/agent skill contract", () => {
  it("ships a skill without a long prompt template or duplicate command", () => {
    expect(manifest.files).toContain("skills");
    expect(manifest.pi.skills).toContain("./skills");
    expect(manifest.pi.prompts).toBeUndefined();
    expect(existsSync(new URL("prompts/agent.md", root))).toBe(false);
    expect(existsSync(new URL(".pi/prompts/agent.md", root))).toBe(false);
    expect(prompt).toMatch(/^---\nname: agent\ndescription: .+\ndisable-model-invocation: true\n---/);
  });

  it("loads the explicit-only skill and uses appended native task arguments", () => {
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: fileURLToPath(new URL("skills/agent/", root)),
      source: "test",
    });
    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "agent", disableModelInvocation: true });
    expect(formatSkillsForPrompt(skills)).not.toContain("<name>agent</name>");
    expect(prompt).not.toContain("$@");
    includesAll(["指令之后附带的用户请求", "缺少参数", "先澄清", "默认一个", "不影响后续无关请求", "不自动开启或关闭"]);
  });

  it("separates root dispatch from the leaf assignment and binds a complete contract", () => {
    includesAll(["coordinator_task", "coordinator_task_id", "task_agent", "objective", "acceptance", "nonGoals", "writePaths", "dependencies"]);
    includesAll(["只发给 worker", "上下文", "目标", "范围与禁止事项", "执行建议", "验收", "沟通与决策边界", "交付"]);
    includesAll(["不能创建 fork、teammate 或 team", "不要传 `team_name`", "不要把整份主会话流程复制", "持续模式关闭也必须显式绑定"]);
    expect(prompt.indexOf('action: "create"')).toBeLessThan(prompt.indexOf("再调用一次 `task_agent`"));
  });

  it("yields immediately and only handles relevant asynchronous events afterwards", () => {
    includesAll(["逻辑任务 ID", "执行 task ID", "立即结束当前回合", "不循环调用", "不 sleep", "用户主动查询", "不并行修改 worker 尚负责的文件"]);
    includesAll(["localagent_message", "target_version", "expected_revision", "task_kill", "不复活终态 worker", "不无界自动重派"]);
  });

  it("defines exception, acknowledgement and safe blocking handoff reports", () => {
    includesAll(["localagent_report", "event_id", "targetVersion", "scope_change", "interface_change", "acknowledgement", "messageId", "direction", "impact"]);
    includesAll(["blocked", "problem", "evidence", "tried", "recommendation", "modifiedFiles", "verification", "remaining", "自然结束", "不无限 idle"]);
    includesAll(["failed", "checkpoint", "requiresAction", "不先做后报", "queued/entered/handled", "不代表你已理解", "notificationError"]);
  });

  it("requires actual delivery evidence and independent root acceptance", () => {
    includesAll(["delivered", "modifiedFiles", "acceptance", "verification", "specialHandling", "deviations", "risks", "remaining", "无则 `[]`"]);
    includesAll(["实际执行的命令", "不能伪造通过", "不得宣称通过", "reviewEvidence", 'status: "accepted"', "不把 worker 正常结束当作目标已验收"]);
  });

  it("does not turn delegation into a permission or ownership bypass", () => {
    includesAll(["只读、探索、规划和审批", "writePaths: []", "保留已有未提交改动", "不是文件沙箱", "父会话须持久化", "不擅自激活工具"]);
    includesAll(["不静默降级", "文件责任冲突", "不通过改写路径", "不能把创建了契约说成已成功启动", "只有规划授权时不得派发实现任务"]);
  });
});
