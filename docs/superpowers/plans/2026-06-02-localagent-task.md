# LocalAgent (`local_agent`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **本期 implementer subagent 一律用 opus，不要 sonnet（用户硬约束）。**

**Goal:** 在 Pi 主进程内派发独立 LLM sub-AgentSession 作为 `local_agent` task type，挂上 `task_agent` LLM 工具（含三态执行 / fork 路径 / agent 定义加载 / 完整接入 A 期 task 框架），整体行为对齐 claudecode 原版 AgentTool。

**Architecture:** 直接调 SDK `createAgentSessionFromServices` 起进程内 sub-session（spike 已验证），共享主 services（authStorage / modelRegistry / resourceLoader），sub-session 有独立 SessionManager（inMemory 或 forkFrom），独立 tools 白名单（agent 定义控制 + 永远剔除 task_agent 防递归）。`subscribe` 监听事件流，转译写到 outputFile。三态执行（同步默认 / 自动后台 timeout 120s / 显式后台 + fork 强制后台），后台路径走 A 期 `notifyTaskTerminal`。

**Tech Stack:** TypeScript ESM strict + 双引号 + 两空格 + Vitest globals + typebox + `@earendil-works/pi-coding-agent` SDK（`AgentSession` / `createAgentSessionFromServices` / `createAgentSessionServices` / `SessionManager` / `parseFrontmatter`）。

---

## 文件结构

```
extensions/localagent/
├── package.json                            # 同 B 期风格,name: pi-localagent-extension
├── _spike/                                 # Task 0 用,Task 12 删除
│   └── sdkProbe.test.ts                    # 30 分钟 SDK 接口确认
├── types.ts                                # AgentDefinition / LocalAgentTaskState
├── boilerplate.ts                          # FORK_BOILERPLATE_TAG / FORK_PLACEHOLDER_RESULT / buildChildDirective
├── boilerplate.test.ts
├── recursionGuard.ts                       # isInForkChild(messages)
├── recursionGuard.test.ts
├── agentDefinitions/
│   ├── builtIn.ts                          # GENERAL_PURPOSE / EXPLORE / FORK_AGENT 三个内置
│   ├── builtIn.test.ts
│   ├── frontmatter.ts                      # parse + validate frontmatter into AgentDefinition
│   ├── frontmatter.test.ts
│   ├── loadFromDisk.ts                     # 用户级 ~/.pi/agents/*.md + 项目级 <cwd>/.pi/agents/*.md
│   ├── loadFromDisk.test.ts
│   ├── resolve.ts                          # 合并优先级 + 按 agentType 查找
│   └── resolve.test.ts
├── toolPool.ts                             # resolveSubAgentTools — 含 * 展开 + disallowed + 永远剔除 task_agent
├── toolPool.test.ts
├── progress.ts                             # AgentProgress 计数 + Map<taskId, progress>
├── progress.test.ts
├── outputTranslator.ts                     # subscribe 事件 → outputFile 行
├── outputTranslator.test.ts
├── buildForkedMessages.ts                  # 给 forked SM 补占位 tool_result(依赖 Task 0 结论)
├── buildForkedMessages.test.ts
├── spawnLocalAgent.ts                      # 三态汇合的主流程
├── spawnLocalAgent.test.ts
├── localAgentTask.ts                       # Task 接口实现 + _bindPi/_unbindPi + state shape
├── localAgentTask.test.ts
├── kill.ts                                 # killLocalAgentTask (顺序敏感)
├── kill.test.ts
├── tools/
│   ├── taskAgent.ts                        # task_agent tool execute
│   └── taskAgent.test.ts
├── index.ts                                # extension entrypoint
└── index.test.ts
```

12 个 Task，每个 Task 末尾独立 commit，每步必须 typecheck + 全仓 vitest 都绿才能进下一步。

---

### Task 0: SDK 接口探针 (一次性)

**目的：** 在写真实现前用 30 分钟 spike 锁住 spec §5.3 / §7 / §8 的三个开放问题。失败/不通则 plan 需要调整。

**Files:**
- Create: `extensions/localagent/_spike/sdkProbe.test.ts`
- Create: `extensions/localagent/package.json`

- [ ] **Step 1: 写 package.json（让 vitest 识别 _spike 测试也属于本扩展）**

```json
{
  "name": "pi-localagent-extension",
  "version": "0.1.0",
  "type": "module",
  "main": "index.ts",
  "pi": {
    "extensions": ["index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  }
}
```

注意此时 `index.ts` 不存在，Pi 加载会报错——但本期还没装这个扩展到 main session，不影响。

- [ ] **Step 2: 写 SDK 接口探针测试，3 个 it 块对应 3 个开放问题**

`extensions/localagent/_spike/sdkProbe.test.ts`：

```ts
// SDK 接口探针 — 一次性 spike,Task 12 整个 _spike/ 目录会被删。
//
// 验证 spec §5.3/§7/§8 的开放问题:
//   1. SessionManager 提供哪些 entry 写入 API
//   2. message_end[assistant].usage 是 per-message 增量还是 cumulative
//   3. session.abort() 后立刻 dispose 是否安全(顺序敏感性)

import { describe, it, expect } from "vitest";
import {
  SessionManager,
  createAgentSessionServices,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";

describe("SDK probe — SessionManager append-entry surface", () => {
  it("枚举 SessionManager 实例的所有 public 方法,定位写入接口", () => {
    const sm = SessionManager.inMemory("/tmp");
    const proto = Object.getPrototypeOf(sm);
    const methodNames = Object.getOwnPropertyNames(proto)
      .filter((n) => typeof (sm as Record<string, unknown>)[n] === "function")
      .filter((n) => !n.startsWith("_") && n !== "constructor")
      .sort();
    // 不强断言具体内容,只把列表打到 console 让人肉确认
    // eslint-disable-next-line no-console
    console.log("[SDK probe] SessionManager methods:", JSON.stringify(methodNames, null, 2));
    expect(methodNames.length).toBeGreaterThan(0);
  });
});

describe("SDK probe — message usage semantics", () => {
  it("跑一个简单 prompt,把 message_end[assistant].usage 全部打出来看 cumulative vs incremental", async () => {
    if (!process.env.PI_PROBE_LIVE) {
      // CI 跳过(需真 LLM token)
      return;
    }
    const services = await createAgentSessionServices({ cwd: process.cwd() });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: ["read"],
    });
    const usages: unknown[] = [];
    const unsub = session.subscribe((event) => {
      if (event.type === "message_end") {
        const m = event.message as { role?: string; usage?: unknown };
        if (m.role === "assistant" && m.usage) usages.push(m.usage);
      }
    });
    await session.prompt("Say A. Then say B. Then say C. Three separate replies, each <5 words.");
    await new Promise<void>((resolve) => {
      const unsub2 = session.subscribe((event) => {
        if (event.type === "agent_end") {
          unsub2();
          resolve();
        }
      });
    });
    unsub();
    session.dispose();
    // eslint-disable-next-line no-console
    console.log("[SDK probe] assistant usages:", JSON.stringify(usages, null, 2));
    expect(usages.length).toBeGreaterThan(0);
  });
});

describe("SDK probe — abort + dispose race", () => {
  it("跑 long prompt,中途 abort 后立即 dispose,确认无 unhandled rejection", async () => {
    if (!process.env.PI_PROBE_LIVE) return;
    const services = await createAgentSessionServices({ cwd: process.cwd() });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(process.cwd()),
      tools: ["read"],
    });
    const promptDone = session.prompt("Count slowly from 1 to 100, one number per line.");
    await new Promise((r) => setTimeout(r, 500));
    await session.abort();
    session.dispose();
    await promptDone.catch(() => {/* expected */});
    // 没炸就算过
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 3: 跑 spike 测试**

```bash
npm test -- extensions/localagent/_spike
```

预期：所有 it 块通过（live 测试 skip）。Step 1 的 console 输出包含 SessionManager 的所有方法名，**人肉读它**判断哪个方法可以 append entry。

- [ ] **Step 4: 跑带 live 模式的 probe（仅在有 token 的开发环境）**

```bash
PI_PROBE_LIVE=1 npm test -- extensions/localagent/_spike
```

读 console 输出，回答 spec 三个开放问题：

| 问题 | 探针发现 | 回到代码的影响 |
|---|---|---|
| §5.3 SessionManager append API | 见 console 列表 | Task 7 buildForkedMessages 用哪个方法 |
| §7 usage cumulative? | 看打出来的 usages 数组每条 totalTokens 是否单调递增 | Task 4 progress.tokenCount 是累加还是赋值最新 |
| §8 abort+dispose race | 是否 unhandled rejection | Task 9 kill 的代码注释 |

- [ ] **Step 5: 把发现写进 probe 文件顶部 注释（让 Task 7/4/9 implementer 直接读到）**

`extensions/localagent/_spike/sdkProbe.test.ts` 顶部添加注释块：

```ts
// PROBE FINDINGS (本节由 Task 0 implementer 跑完测试后填写,后续 Task 必须读):
//
// §5.3 SessionManager append API:
//   - 实测可用方法: <填:appendEntry / addEntry / 其他>
//   - 签名: <填具体>
//   - 备选: 若不可用, 用 fs.appendFileSync + SessionManager.open 重新加载
//
// §7 usage 语义:
//   - <填:cumulative 或 incremental>
//   - Task 4 progress.tokenCount 用 <累加 / 取最新>
//
// §8 abort+dispose race:
//   - 实测顺序: abort settle → unsub → dispose 安全
//   - <若有 unhandled rejection: 描述哪条 promise 需要 .catch>
```

- [ ] **Step 6: 提交 probe**

```bash
git add extensions/localagent/package.json extensions/localagent/_spike/
git commit -m "spike(localagent): SDK interface probe for plan Tasks 4/7/9

Probes:
- SessionManager append-entry API surface
- message_end[assistant].usage semantics (cumulative vs incremental)
- session.abort() + dispose() race condition

Findings recorded inline in sdkProbe.test.ts header.
Probe will be deleted in Task 12.
"
```

---

### Task 1: 类型定义 (`types.ts`)

**Files:**
- Create: `extensions/localagent/types.ts`

无测试（纯类型）。

- [ ] **Step 1: 写类型文件**

```ts
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { TaskStateBase } from "../tasks/Task.js";

export type AgentSource = "built-in" | "user" | "project";

export interface AgentDefinition {
  /** 唯一名,也是 task_agent.subagent_type 的字面量。FORK_AGENT 用 "__fork__"。 */
  agentType: string;
  /** 写到 task_agent description 给主 LLM 看,辅助选 agent。 */
  whenToUse: string;
  /** 显式工具白名单。可含 "*" 表示全开。不写时由 toolPool.ts 用安全默认 [read,grep,find,ls]。 */
  tools?: string[];
  /** 黑名单,优先级高于 tools。 */
  disallowedTools?: string[];
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  background?: boolean;
  maxTurns?: number;
  description?: string;
  source: AgentSource;
  filename?: string;
  /** sub-session 的 system prompt。FORK_AGENT 留空(继承父)。 */
  systemPrompt: string;
}

export interface AgentProgress {
  toolCallCount: number;
  tokenCount: number;
  startTime: number;
  recentToolNames: string[];
}

/** Task 0 probe 决定累加还是赋值最新值,见 Task 4 progress.test.ts。 */

export interface LocalAgentTaskResult {
  finalText: string;
  toolCallCount: number;
  tokenCount: number;
}

export interface LocalAgentTaskState extends TaskStateBase {
  type: "local_agent";
  prompt: string;
  agentType: string;
  model?: string;
  isBackgrounded: boolean;
  isFork: boolean;
  forkParentSessionFile?: string;
  /** 运行时句柄(不进 jsonl 持久化,但内存中需要持有以供 kill)。 */
  session?: AgentSession;
  cleanup?: () => void;
  progress?: AgentProgress;
  result?: LocalAgentTaskResult;
  error?: string;
}
```

- [ ] **Step 2: typecheck**

```bash
npx tsc --noEmit
```

预期：通过（无错误）。

- [ ] **Step 3: 全仓 vitest**

```bash
npm test 2>&1 | tail -3
```

预期：391 全绿（A+B 期不变）。

- [ ] **Step 4: 提交**

```bash
git add extensions/localagent/types.ts
git commit -m "feat(localagent): add LocalAgentTaskState + AgentDefinition types"
```

---

### Task 2: Boilerplate 常量 + child directive

**Files:**
- Create: `extensions/localagent/boilerplate.ts`
- Create: `extensions/localagent/boilerplate.test.ts`

- [ ] **Step 1: 写测试**

`extensions/localagent/boilerplate.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import {
  FORK_BOILERPLATE_TAG,
  FORK_PLACEHOLDER_RESULT,
  buildChildDirective,
} from "./boilerplate.js";

describe("FORK_BOILERPLATE_TAG", () => {
  it("是固定常量字符串", () => {
    expect(FORK_BOILERPLATE_TAG).toBe("fork_boilerplate");
  });
});

describe("FORK_PLACEHOLDER_RESULT", () => {
  it("是固定字符串(全 fork child 共享 → prompt cache 友好)", () => {
    expect(FORK_PLACEHOLDER_RESULT).toBe("Subagent forked — running in background");
  });
});

describe("buildChildDirective", () => {
  it("把 boilerplate 包到 prompt 前面", () => {
    const out = buildChildDirective("explore the auth module");
    expect(out).toContain(`<${FORK_BOILERPLATE_TAG}>`);
    expect(out).toContain(`</${FORK_BOILERPLATE_TAG}>`);
    expect(out).toContain("explore the auth module");
  });

  it("boilerplate 包含核心规则文字", () => {
    const out = buildChildDirective("hi");
    expect(out).toContain("STOP");
    expect(out).toContain("Do NOT spawn sub-agents");
    expect(out).toContain("Use your tools directly");
    expect(out).toContain("Begin your final response");
  });

  it("不同 prompt 拼出来除最后 prompt 部分外字节相同(cache 友好性)", () => {
    const a = buildChildDirective("AAA");
    const b = buildChildDirective("BBB");
    expect(a.slice(0, a.lastIndexOf("AAA"))).toBe(b.slice(0, b.lastIndexOf("BBB")));
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
npm test -- extensions/localagent/boilerplate
```

预期：`Cannot find module './boilerplate.js'`。

- [ ] **Step 3: 实现**

`extensions/localagent/boilerplate.ts`：

```ts
// Fork boilerplate — 注入 forked sub-session prompt 前缀,告诉 LLM 它是 worker 不是 leader。
//
// 设计要点:
//   - FORK_BOILERPLATE_TAG / FORK_PLACEHOLDER_RESULT 必须是 const,
//     所有 fork child 共享同一字节序列 → prompt cache 命中。
//   - buildChildDirective 拼接顺序: boilerplate + 空行 + user prompt。

export const FORK_BOILERPLATE_TAG = "fork_boilerplate";

/** Placeholder text used for all tool_result blocks in the fork prefix. */
export const FORK_PLACEHOLDER_RESULT = "Subagent forked — running in background";

const BOILERPLATE_BODY = `STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES (non-negotiable):
1. Do NOT spawn sub-agents; execute directly.
2. Use your tools directly: read, grep, find, ls, bash, edit, write.
3. Stay strictly within your assigned scope.
4. Keep your final report under 500 words unless directed otherwise.
5. Begin your final response with "Scope:".`;

export function buildChildDirective(userPrompt: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
${BOILERPLATE_BODY}
</${FORK_BOILERPLATE_TAG}>

${userPrompt}`;
}
```

- [ ] **Step 4: 跑测试,确认 GREEN**

```bash
npm test -- extensions/localagent/boilerplate
```

预期：5 tests passing。

- [ ] **Step 5: typecheck + 全仓**

```bash
npx tsc --noEmit && npm test 2>&1 | tail -3
```

预期：391 + 5 = 396 全绿。

- [ ] **Step 6: 提交**

```bash
git add extensions/localagent/boilerplate.ts extensions/localagent/boilerplate.test.ts
git commit -m "feat(localagent): add fork boilerplate constants + buildChildDirective"
```

---

### Task 3: 防递归 (`recursionGuard.ts`)

**Files:**
- Create: `extensions/localagent/recursionGuard.ts`
- Create: `extensions/localagent/recursionGuard.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from "vitest";
import { isInForkChild } from "./recursionGuard.js";
import { FORK_BOILERPLATE_TAG } from "./boilerplate.js";

function userMsg(text: string): unknown {
  return { role: "user", content: [{ type: "text", text }] };
}

describe("isInForkChild", () => {
  it("空数组返回 false", () => {
    expect(isInForkChild([])).toBe(false);
  });

  it("没 boilerplate tag 的纯对话返回 false", () => {
    expect(
      isInForkChild([userMsg("hello"), userMsg("world")]),
    ).toBe(false);
  });

  it("user message 含 boilerplate tag 返回 true", () => {
    const msg = userMsg(`<${FORK_BOILERPLATE_TAG}>STOP</${FORK_BOILERPLATE_TAG}>\n\nDo X`);
    expect(isInForkChild([msg])).toBe(true);
  });

  it("assistant message 含 tag(罕见情况)返回 false — claude 原版只检 user", () => {
    const msg = { role: "assistant", content: [{ type: "text", text: `<${FORK_BOILERPLATE_TAG}>` }] };
    expect(isInForkChild([msg])).toBe(false);
  });

  it("content 是 string 不是数组也能识别", () => {
    expect(isInForkChild([{ role: "user", content: `<${FORK_BOILERPLATE_TAG}>` }])).toBe(true);
  });

  it("content 数组里多个 block,只要有一个 text block 含 tag 就 true", () => {
    expect(
      isInForkChild([
        {
          role: "user",
          content: [
            { type: "text", text: "前缀无关" },
            { type: "text", text: `<${FORK_BOILERPLATE_TAG}>` },
          ],
        },
      ]),
    ).toBe(true);
  });
});
```

- [ ] **Step 2: 确认 RED**

```bash
npm test -- extensions/localagent/recursionGuard
```

- [ ] **Step 3: 实现**

```ts
import { FORK_BOILERPLATE_TAG } from "./boilerplate.js";

interface MaybeMessage {
  role?: string;
  content?: unknown;
}

interface MaybeTextBlock {
  type?: string;
  text?: string;
}

const TAG_OPEN = `<${FORK_BOILERPLATE_TAG}>`;

/**
 * Detect whether the parent's message history shows we are already inside a
 * fork child. Used as a defense-in-depth check on top of the tool-pool
 * removal of `task_agent` from sub-agent tools.
 */
export function isInForkChild(messages: readonly unknown[]): boolean {
  return messages.some((raw) => {
    const m = raw as MaybeMessage;
    if (m?.role !== "user") return false;
    const c = m.content;
    if (typeof c === "string") return c.includes(TAG_OPEN);
    if (!Array.isArray(c)) return false;
    return c.some((block) => {
      const b = block as MaybeTextBlock;
      return b?.type === "text" && typeof b.text === "string" && b.text.includes(TAG_OPEN);
    });
  });
}
```

- [ ] **Step 4: 确认 GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/recursionGuard
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：6 tests pass，全仓 396 + 6 = 402。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/recursionGuard.ts extensions/localagent/recursionGuard.test.ts
git commit -m "feat(localagent): add recursionGuard.isInForkChild for defense-in-depth"
```

---

### Task 4: 内置 agent 定义 (`agentDefinitions/builtIn.ts`)

**Files:**
- Create: `extensions/localagent/agentDefinitions/builtIn.ts`
- Create: `extensions/localagent/agentDefinitions/builtIn.test.ts`

- [ ] **Step 1: 写测试**

```ts
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
```

- [ ] **Step 2: 确认 RED**

```bash
npm test -- extensions/localagent/agentDefinitions/builtIn
```

- [ ] **Step 3: 实现**

```ts
import type { AgentDefinition } from "../types.js";

export const FORK_AGENT_TYPE = "__fork__" as const;

export const GENERAL_PURPOSE_AGENT: AgentDefinition = {
  agentType: "general-purpose",
  whenToUse:
    "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  source: "built-in",
  systemPrompt:
    "You are a general-purpose research and execution agent dispatched by a parent agent. " +
    "Stay strictly within the assigned task. Use your tools directly; do not converse, " +
    "ask questions, or speculate beyond the task. When done, return a concise factual report.",
};

export const EXPLORE_AGENT: AgentDefinition = {
  agentType: "explore",
  whenToUse: "Read-only codebase exploration. Returns excerpts, doesn't modify files.",
  tools: ["read", "grep", "find", "ls"],
  source: "built-in",
  systemPrompt:
    "You are a read-only codebase explorer. You have file-read and search tools only. " +
    "Locate relevant code, return file paths and short excerpts; do not summarize or " +
    "editorialize. Output format: { files: [{path, lineRange, excerpt}], notes: string[] }.",
};

export const FORK_AGENT: AgentDefinition = {
  agentType: FORK_AGENT_TYPE,
  whenToUse: "Implicit fork — inherits full conversation context.",
  tools: ["*"],
  background: true,
  source: "built-in",
  systemPrompt: "",
};

/** LLM 可见的内置 agent 列表(不含 FORK_AGENT)。 */
export function getBuiltInAgents(): AgentDefinition[] {
  return [GENERAL_PURPOSE_AGENT, EXPLORE_AGENT];
}
```

- [ ] **Step 4: 确认 GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/agentDefinitions/builtIn
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：12 tests，全仓 414。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/agentDefinitions/builtIn.ts extensions/localagent/agentDefinitions/builtIn.test.ts
git commit -m "feat(localagent): add built-in agents (general-purpose, explore, FORK_AGENT)"
```

---

### Task 5: frontmatter 解析 (`agentDefinitions/frontmatter.ts`)

**Files:**
- Create: `extensions/localagent/agentDefinitions/frontmatter.ts`
- Create: `extensions/localagent/agentDefinitions/frontmatter.test.ts`

- [ ] **Step 1: 写测试**

```ts
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
    const result = parseAgentMarkdown(md, "user", "explorer.md") as { ok: true; def: ParseAgentResult["def"] };
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
```

- [ ] **Step 2: 确认 RED**

```bash
npm test -- extensions/localagent/agentDefinitions/frontmatter
```

- [ ] **Step 3: 实现**

```ts
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentSource } from "../types.js";

export type ParseAgentResult =
  | { ok: true; def: AgentDefinition }
  | { ok: false; error: string };

const ALLOWED_MODELS = new Set(["sonnet", "opus", "haiku", "inherit"]);

export function parseAgentMarkdown(
  content: string,
  source: AgentSource,
  filename: string,
): ParseAgentResult {
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter<Record<string, unknown>>(content);
  } catch (e) {
    return { ok: false, error: `parseFrontmatter failed: ${(e as Error).message}` };
  }
  const fm = parsed.frontmatter ?? {};
  if (Object.keys(fm).length === 0) {
    return { ok: false, error: "no frontmatter found" };
  }

  const agentType = fm.agentType;
  if (typeof agentType !== "string" || !agentType) {
    return { ok: false, error: "agentType (string) is required" };
  }
  const whenToUse = fm.whenToUse;
  if (typeof whenToUse !== "string" || !whenToUse) {
    return { ok: false, error: "whenToUse (string) is required" };
  }

  let model: AgentDefinition["model"] | undefined;
  if (fm.model !== undefined) {
    if (typeof fm.model !== "string" || !ALLOWED_MODELS.has(fm.model)) {
      return { ok: false, error: `model must be sonnet|opus|haiku|inherit, got ${String(fm.model)}` };
    }
    model = fm.model as AgentDefinition["model"];
  }

  const tools = stringArrayOrUndef(fm.tools);
  const disallowedTools = stringArrayOrUndef(fm.disallowedTools);
  const background = typeof fm.background === "boolean" ? fm.background : undefined;
  const maxTurns = typeof fm.maxTurns === "number" ? fm.maxTurns : undefined;
  const description = typeof fm.description === "string" ? fm.description : undefined;

  return {
    ok: true,
    def: {
      agentType,
      whenToUse,
      tools,
      disallowedTools,
      model,
      background,
      maxTurns,
      description,
      source,
      filename,
      systemPrompt: parsed.body.trim() === "" ? "" : parsed.body.trimEnd().replace(/^\n+/, ""),
    },
  };
}

function stringArrayOrUndef(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (v.every((x) => typeof x === "string")) return v as string[];
  return undefined;
}
```

- [ ] **Step 4: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/agentDefinitions/frontmatter
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：8 tests，全仓 422。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/agentDefinitions/frontmatter.ts extensions/localagent/agentDefinitions/frontmatter.test.ts
git commit -m "feat(localagent): parse markdown frontmatter into AgentDefinition"
```

---

### Task 6: 用户级 + 项目级 agent 加载 + resolve

**Files:**
- Create: `extensions/localagent/agentDefinitions/loadFromDisk.ts`
- Create: `extensions/localagent/agentDefinitions/loadFromDisk.test.ts`
- Create: `extensions/localagent/agentDefinitions/resolve.ts`
- Create: `extensions/localagent/agentDefinitions/resolve.test.ts`

- [ ] **Step 1: 写 loadFromDisk 测试**

`extensions/localagent/agentDefinitions/loadFromDisk.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentsFromDir } from "./loadFromDisk.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "localagent-test-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadAgentsFromDir", () => {
  it("目录不存在 → 返回空数组,不报错", async () => {
    const out = await loadAgentsFromDir(join(tmp, "nope"), "user");
    expect(out).toEqual([]);
  });

  it("目录空 → 空数组", async () => {
    mkdirSync(join(tmp, "agents"));
    const out = await loadAgentsFromDir(join(tmp, "agents"), "user");
    expect(out).toEqual([]);
  });

  it("加载多个 .md 文件", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(
      join(dir, "a.md"),
      `---
agentType: a
whenToUse: x
---
A body`,
    );
    writeFileSync(
      join(dir, "b.md"),
      `---
agentType: b
whenToUse: y
---
B body`,
    );
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toHaveLength(2);
    const types = out.map((d) => d.agentType).sort();
    expect(types).toEqual(["a", "b"]);
  });

  it("解析失败的文件被跳过(不影响其他)", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "good.md"), `---\nagentType: g\nwhenToUse: x\n---\nbody`);
    writeFileSync(join(dir, "bad.md"), `not a frontmatter file`);
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toHaveLength(1);
    expect(out[0]!.agentType).toBe("g");
  });

  it("非 .md 后缀被忽略", async () => {
    const dir = join(tmp, "agents");
    mkdirSync(dir);
    writeFileSync(join(dir, "a.txt"), `---\nagentType: a\nwhenToUse: x\n---\n`);
    const out = await loadAgentsFromDir(dir, "user");
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/agentDefinitions/loadFromDisk
```

- [ ] **Step 3: 实现 loadFromDisk**

`extensions/localagent/agentDefinitions/loadFromDisk.ts`：

```ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition, AgentSource } from "../types.js";
import { parseAgentMarkdown } from "./frontmatter.js";

/**
 * Load all *.md files in `dir` as AgentDefinition. Missing dir → []. Parse
 * errors are silently skipped (file may not be an agent definition).
 */
export async function loadAgentsFromDir(
  dir: string,
  source: AgentSource,
): Promise<AgentDefinition[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    if (typeof e === "object" && e && "code" in e && (e as { code: unknown }).code === "ENOENT") {
      return [];
    }
    throw e;
  }
  const out: AgentDefinition[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    try {
      const content = await readFile(join(dir, name), "utf8");
      const r = parseAgentMarkdown(content, source, name);
      if (r.ok) out.push(r.def);
    } catch {/* skip unreadable file */}
  }
  return out;
}
```

- [ ] **Step 4: GREEN**

```bash
npm test -- extensions/localagent/agentDefinitions/loadFromDisk
```

- [ ] **Step 5: 写 resolve 测试**

`extensions/localagent/agentDefinitions/resolve.test.ts`：

```ts
import { describe, it, expect } from "vitest";
import { mergeAgentDefinitions, getAgentDefinition } from "./resolve.js";
import type { AgentDefinition } from "../types.js";

const builtIn: AgentDefinition = {
  agentType: "x",
  whenToUse: "B",
  tools: ["read"],
  source: "built-in",
  systemPrompt: "built-in",
};
const user: AgentDefinition = {
  agentType: "x",
  whenToUse: "U",
  tools: ["read", "grep"],
  source: "user",
  systemPrompt: "user",
};
const project: AgentDefinition = {
  agentType: "x",
  whenToUse: "P",
  tools: ["read", "grep", "find"],
  source: "project",
  systemPrompt: "project",
};

describe("mergeAgentDefinitions", () => {
  it("project > user > built-in 的覆盖优先级", () => {
    const merged = mergeAgentDefinitions([builtIn], [user], [project]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.systemPrompt).toBe("project");
    expect(merged[0]!.tools).toEqual(["read", "grep", "find"]);
  });

  it("user 覆盖 built-in,无 project", () => {
    const merged = mergeAgentDefinitions([builtIn], [user], []);
    expect(merged[0]!.systemPrompt).toBe("user");
  });

  it("不同 agentType 都保留", () => {
    const a: AgentDefinition = { ...builtIn, agentType: "a" };
    const b: AgentDefinition = { ...user, agentType: "b" };
    const merged = mergeAgentDefinitions([a], [b], []);
    expect(merged.map((d) => d.agentType).sort()).toEqual(["a", "b"]);
  });
});

describe("getAgentDefinition", () => {
  it("找到的 agent 直接返回", () => {
    const r = getAgentDefinition([builtIn], "x");
    expect(r).toBe(builtIn);
  });
  it("找不到返回 undefined", () => {
    expect(getAgentDefinition([builtIn], "nope")).toBeUndefined();
  });
});
```

- [ ] **Step 6: RED**

```bash
npm test -- extensions/localagent/agentDefinitions/resolve
```

- [ ] **Step 7: 实现 resolve**

`extensions/localagent/agentDefinitions/resolve.ts`：

```ts
import type { AgentDefinition } from "../types.js";

/**
 * Merge agent definitions. Priority: project > user > built-in.
 * For each agentType the highest-priority definition wins entirely
 * (no field-level merge).
 */
export function mergeAgentDefinitions(
  builtIn: AgentDefinition[],
  user: AgentDefinition[],
  project: AgentDefinition[],
): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  for (const d of builtIn) map.set(d.agentType, d);
  for (const d of user) map.set(d.agentType, d);
  for (const d of project) map.set(d.agentType, d);
  return Array.from(map.values());
}

export function getAgentDefinition(
  defs: AgentDefinition[],
  agentType: string,
): AgentDefinition | undefined {
  return defs.find((d) => d.agentType === agentType);
}
```

- [ ] **Step 8: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/agentDefinitions
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：5 + 5 = 10 tests，全仓 432。

- [ ] **Step 9: 提交**

```bash
git add extensions/localagent/agentDefinitions/loadFromDisk.ts extensions/localagent/agentDefinitions/loadFromDisk.test.ts extensions/localagent/agentDefinitions/resolve.ts extensions/localagent/agentDefinitions/resolve.test.ts
git commit -m "feat(localagent): load agent .md files from disk + merge with priority"
```

---

### Task 7: 工具池构造 (`toolPool.ts`)

**Files:**
- Create: `extensions/localagent/toolPool.ts`
- Create: `extensions/localagent/toolPool.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect } from "vitest";
import { resolveSubAgentTools } from "./toolPool.js";
import type { AgentDefinition } from "./types.js";

const base: AgentDefinition = {
  agentType: "x",
  whenToUse: "x",
  source: "built-in",
  systemPrompt: "",
};

describe("resolveSubAgentTools", () => {
  it("无 tools 字段 → 默认只读 [read,grep,find,ls]", () => {
    expect(resolveSubAgentTools(base, ["read", "grep", "find", "ls", "bash"])).toEqual([
      "read", "grep", "find", "ls",
    ]);
  });

  it("tools=['*'] → 用 allRegistered", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["*"] }, ["read", "bash", "task_bash"]),
    ).toEqual(["read", "bash", "task_bash"]);
  });

  it("显式 tools → 用 tools", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["read", "bash"] }, ["read", "grep", "bash", "edit"]),
    ).toEqual(["read", "bash"]);
  });

  it("disallowedTools 把 tools 里的剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "bash", "edit"], disallowedTools: ["bash"] },
        ["read", "bash", "edit"],
      ),
    ).toEqual(["read", "edit"]);
  });

  it("永远剔除 task_agent — 即使 agentDef.tools 显式包含也剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "task_agent", "grep"] },
        ["read", "task_agent", "grep"],
      ),
    ).toEqual(["read", "grep"]);
  });

  it("永远剔除 task_agent — 即使是 * 展开也剔除", () => {
    expect(
      resolveSubAgentTools({ ...base, tools: ["*"] }, ["read", "task_agent"]),
    ).toEqual(["read"]);
  });

  it("disallowed 优先级高于 tools — bash 在两边都出现也剔除", () => {
    expect(
      resolveSubAgentTools(
        { ...base, tools: ["read", "bash"], disallowedTools: ["bash"] },
        ["read", "bash"],
      ),
    ).toEqual(["read"]);
  });

  it("空 allRegistered + ['*'] → 空数组", () => {
    expect(resolveSubAgentTools({ ...base, tools: ["*"] }, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/toolPool
```

- [ ] **Step 3: 实现**

```ts
import type { AgentDefinition } from "./types.js";

const SAFE_DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const NEVER_INCLUDE = ["task_agent"] as const;

/**
 * Build the tool whitelist for a sub-AgentSession.
 *
 * Rules:
 *   - agentDef.tools missing → safe defaults (read-only)
 *   - agentDef.tools=["*"] → expand to allRegistered
 *   - agentDef.tools=[...] → use as-is
 *   - apply disallowedTools blacklist
 *   - ALWAYS remove "task_agent" (recursion hard-stop)
 */
export function resolveSubAgentTools(
  agentDef: AgentDefinition,
  allRegistered: readonly string[],
): string[] {
  let tools: string[];
  if (!agentDef.tools) {
    tools = [...SAFE_DEFAULT_TOOLS];
  } else if (agentDef.tools.includes("*")) {
    tools = [...allRegistered];
  } else {
    tools = [...agentDef.tools];
  }
  if (agentDef.disallowedTools?.length) {
    const black = new Set(agentDef.disallowedTools);
    tools = tools.filter((t) => !black.has(t));
  }
  const never = new Set<string>(NEVER_INCLUDE);
  tools = tools.filter((t) => !never.has(t));
  return tools;
}
```

- [ ] **Step 4: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/toolPool
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：8 tests，全仓 440。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/toolPool.ts extensions/localagent/toolPool.test.ts
git commit -m "feat(localagent): resolveSubAgentTools — agent-defined whitelist + recursion guard"
```

---

### Task 8: progress 计数 (`progress.ts`)

**Files:**
- Create: `extensions/localagent/progress.ts`
- Create: `extensions/localagent/progress.test.ts`

注意：本 Task 的 token 累加 vs 取最新由 Task 0 探针结论决定。下面默认按 **incremental（累加）** 写；如探针发现 cumulative，把 `addTokens` 改成 `setTokens`(接收 `usage.totalTokens` 并直接赋值)。

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  initProgress,
  recordToolStart,
  addTokens,
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

  it("addTokens 累加(per-message 增量)", () => {
    initProgress("a1", 0);
    addTokens("a1", 100);
    addTokens("a1", 50);
    expect(getProgress("a1")!.tokenCount).toBe(150);
  });

  it("removeProgress 清掉条目", () => {
    initProgress("a1", 0);
    removeProgress("a1");
    expect(getProgress("a1")).toBeUndefined();
  });

  it("init 已存在的 task → 保留旧值不重置", () => {
    initProgress("a1", 0);
    addTokens("a1", 50);
    initProgress("a1", 100);
    expect(getProgress("a1")!.tokenCount).toBe(50);
    expect(getProgress("a1")!.startTime).toBe(0);
  });

  it("不存在的 task 调 recordToolStart / addTokens 安全(no-op)", () => {
    expect(() => recordToolStart("nope", "x")).not.toThrow();
    expect(() => addTokens("nope", 10)).not.toThrow();
    expect(getProgress("nope")).toBeUndefined();
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/progress
```

- [ ] **Step 3: 实现**

```ts
// In-memory progress tracker. Per-message incremental token semantics.
//
// IF Task 0 probe found cumulative usage instead, replace addTokens with
// `setTokens(taskId, total)` and call from outputTranslator with usage.totalTokens.

import type { AgentProgress } from "./types.js";

const MAX_RECENT = 5;

const _store = new Map<string, AgentProgress>();

export function initProgress(taskId: string, startTime: number): void {
  if (_store.has(taskId)) return;
  _store.set(taskId, {
    toolCallCount: 0,
    tokenCount: 0,
    startTime,
    recentToolNames: [],
  });
}

export function recordToolStart(taskId: string, toolName: string): void {
  const p = _store.get(taskId);
  if (!p) return;
  p.toolCallCount += 1;
  p.recentToolNames = [...p.recentToolNames, toolName].slice(-MAX_RECENT);
}

export function addTokens(taskId: string, delta: number): void {
  const p = _store.get(taskId);
  if (!p) return;
  p.tokenCount += delta;
}

export function getProgress(taskId: string): AgentProgress | undefined {
  return _store.get(taskId);
}

export function removeProgress(taskId: string): void {
  _store.delete(taskId);
}

export function _resetProgressForTest(): void {
  _store.clear();
}
```

- [ ] **Step 4: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/progress
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：6 tests，全仓 446。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/progress.ts extensions/localagent/progress.test.ts
git commit -m "feat(localagent): in-memory progress tracker (toolCalls + tokens)"
```

---

### Task 9: outputTranslator (`outputTranslator.ts`)

**Files:**
- Create: `extensions/localagent/outputTranslator.ts`
- Create: `extensions/localagent/outputTranslator.test.ts`

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { translateAgentEvent } from "./outputTranslator.js";

describe("translateAgentEvent", () => {
  it("tool_execution_start → '[tool] name(args)\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: { file: "a.ts" } } as never,
      (s) => lines.push(s),
    );
    expect(lines).toEqual([`[tool] read({"file":"a.ts"})\n`]);
  });

  it("args 太长被截断到 80 chars + ...", () => {
    const longArg = { x: "a".repeat(200) };
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_start", toolCallId: "1", toolName: "read", args: longArg } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!.length).toBeLessThanOrEqual(120);
    expect(lines[0]!).toMatch(/\.\.\./);
  });

  it("tool_execution_end success → '[ok] name → result\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: { content: "hi" }, isError: false } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/^\[ok\] read /);
  });

  it("tool_execution_end isError → '[err] name: ...'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "tool_execution_end", toolCallId: "1", toolName: "read", result: "boom", isError: true } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/^\[err\] read: boom/);
  });

  it("message_end[assistant] 写 '\\n=== FINAL ===\\n{text}\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Scope: x\nResult: y" }],
        },
      } as never,
      (s) => lines.push(s),
    );
    expect(lines[0]!).toMatch(/=== FINAL ===/);
    expect(lines[0]!).toContain("Scope: x");
  });

  it("message_end[user] 不写", () => {
    const lines: string[] = [];
    translateAgentEvent(
      { type: "message_end", message: { role: "user", content: "hi" } } as never,
      (s) => lines.push(s),
    );
    expect(lines).toEqual([]);
  });

  it("agent_end → '\\n=== END (turns=N, tools=M) ===\\n'", () => {
    const lines: string[] = [];
    translateAgentEvent({ type: "agent_end", messages: new Array(8) } as never, (s) => lines.push(s), { turnCount: 3, toolCount: 5 });
    expect(lines[0]!).toMatch(/=== END \(turns=3, tools=5\) ===/);
  });

  it("message_update / message_start / turn_start / agent_start / queue_update 不输出", () => {
    const types = [
      "message_update",
      "message_start",
      "turn_start",
      "agent_start",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "auto_retry_start",
      "auto_retry_end",
      "thinking_level_changed",
      "session_info_changed",
    ];
    for (const t of types) {
      const lines: string[] = [];
      translateAgentEvent({ type: t } as never, (s) => lines.push(s));
      expect(lines).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/outputTranslator
```

- [ ] **Step 3: 实现**

```ts
// Translate AgentSession events into outputFile lines.
// Only writes:
//   - tool_execution_start / end (with success/err)
//   - message_end[assistant] (the FINAL block)
//   - agent_end (with turn/tool counts from caller)
// Skips streaming updates / thinking / queue / compaction / retry events.

interface Event {
  type: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  message?: { role?: string; content?: unknown };
}

interface AgentEndCounts {
  turnCount?: number;
  toolCount?: number;
}

const ARGS_PREVIEW_MAX = 80;
const RESULT_PREVIEW_MAX = 80;
const ERROR_PREVIEW_MAX = 200;

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function previewJson(v: unknown, max: number): string {
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  if (typeof s !== "string") s = String(s);
  return shorten(s, max);
}

function extractAssistantText(message: unknown): string {
  const m = message as { role?: string; content?: unknown } | undefined;
  if (!m || m.role !== "assistant") return "";
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

export function translateAgentEvent(
  event: Event,
  append: (line: string) => void,
  counts?: AgentEndCounts,
): void {
  switch (event.type) {
    case "tool_execution_start": {
      const args = previewJson(event.args, ARGS_PREVIEW_MAX);
      append(`[tool] ${event.toolName}(${args})\n`);
      return;
    }
    case "tool_execution_end": {
      if (event.isError) {
        append(`[err] ${event.toolName}: ${shorten(String(event.result), ERROR_PREVIEW_MAX)}\n`);
      } else {
        append(`[ok] ${event.toolName} → ${previewJson(event.result, RESULT_PREVIEW_MAX)}\n`);
      }
      return;
    }
    case "message_end": {
      const text = extractAssistantText(event.message);
      if (text) {
        append(`\n=== FINAL ===\n${text}\n`);
      }
      return;
    }
    case "agent_end": {
      const t = counts?.turnCount ?? 0;
      const c = counts?.toolCount ?? 0;
      append(`\n=== END (turns=${t}, tools=${c}) ===\n`);
      return;
    }
    default:
      return;
  }
}
```

- [ ] **Step 4: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/outputTranslator
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：8 tests，全仓 454。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/outputTranslator.ts extensions/localagent/outputTranslator.test.ts
git commit -m "feat(localagent): translate AgentSession events to outputFile lines"
```

---

### Task 10: buildForkedMessages (依赖 Task 0 探针)

**Files:**
- Create: `extensions/localagent/buildForkedMessages.ts`
- Create: `extensions/localagent/buildForkedMessages.test.ts`

**Implementer 必读：** 在写本 Task 前，先读 `extensions/localagent/_spike/sdkProbe.test.ts` 顶部 PROBE FINDINGS 注释确认 SessionManager append API。下文默认探针发现可用 `appendEntry()`；如不可用，按以下 fallback：
- 如果 SDK 暴露 `addMessage()` / `addEntry()` / 类似名 → 改用此名
- 如果完全不暴露 → 用 `fs.appendFileSync(sm.getSessionFile(), JSON.stringify(entry) + "\n")` 然后 `SessionManager.open(sm.getSessionFile())` 重载到新 SM 实例返回

测试用 mock SessionManager，不真碰文件。

- [ ] **Step 1: 写测试**

```ts
import { describe, it, expect, vi } from "vitest";
import { injectForkPlaceholders, type ForkSessionManagerLike } from "./buildForkedMessages.js";
import { FORK_PLACEHOLDER_RESULT } from "./boilerplate.js";

function makeSm(entries: unknown[]): ForkSessionManagerLike & { _appended: unknown[] } {
  const _appended: unknown[] = [];
  return {
    getEntries: () => entries,
    appendToolResultEntry: (entry) => { _appended.push(entry); },
    _appended,
  };
}

describe("injectForkPlaceholders", () => {
  it("末尾 entry 不是 assistant message → 不写任何 placeholder", () => {
    const sm = makeSm([
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });

  it("末尾 assistant message 没 tool_use → 不写", () => {
    const sm = makeSm([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });

  it("末尾 assistant 含 1 个 tool_use → 写 1 个 placeholder", () => {
    const sm = makeSm([
      { role: "user", content: "fork" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking..." },
          { type: "tool_use", id: "tu_abc", name: "task_agent", input: {} },
        ],
      },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(1);
    const e = sm._appended[0] as { role: string; toolCallId: string; content: unknown };
    expect(e.role).toBe("toolResult");
    expect(e.toolCallId).toBe("tu_abc");
    expect(e.content).toEqual([{ type: "text", text: FORK_PLACEHOLDER_RESULT }]);
  });

  it("末尾 assistant 含多个 tool_use → 写多个 placeholder,每个用同一 PLACEHOLDER 字符串", () => {
    const sm = makeSm([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "x", input: {} },
          { type: "tool_use", id: "tu2", name: "y", input: {} },
          { type: "tool_use", id: "tu3", name: "z", input: {} },
        ],
      },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(3);
    for (const e of sm._appended) {
      const t = e as { content: { text: string }[] };
      expect(t.content[0]!.text).toBe(FORK_PLACEHOLDER_RESULT);
    }
    const ids = sm._appended.map((e) => (e as { toolCallId: string }).toolCallId);
    expect(ids).toEqual(["tu1", "tu2", "tu3"]);
  });

  it("已经有对应 toolResult 的 tool_use 不再补占位", () => {
    const sm = makeSm([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu1", name: "x", input: {} },
          { type: "tool_use", id: "tu2", name: "y", input: {} },
        ],
      },
      { role: "toolResult", toolCallId: "tu1", content: [{ type: "text", text: "done" }], isError: false },
    ]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toHaveLength(1);
    expect((sm._appended[0] as { toolCallId: string }).toolCallId).toBe("tu2");
  });

  it("空 entries → 不写", () => {
    const sm = makeSm([]);
    injectForkPlaceholders(sm);
    expect(sm._appended).toEqual([]);
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/buildForkedMessages
```

- [ ] **Step 3: 实现 — 注意先按 Task 0 探针结论选用 SDK 真接口**

`extensions/localagent/buildForkedMessages.ts`：

```ts
// Inject placeholder tool_result entries into a forked SessionManager.
//
// Why: SessionManager.forkFrom copies the parent jsonl verbatim. If the
// parent's tail is an assistant message containing in-flight tool_use
// blocks (the very tool call that triggered the fork), the forked sub-
// session sees an assistant turn with unmatched tool_use → the LLM
// either hallucinates a tool_result or treats itself as the parent.
//
// Fix: for every unmatched tool_use, append a toolResult entry with
// FORK_PLACEHOLDER_RESULT (constant string → all fork children share
// the same prefix bytes → prompt cache hits).
//
// IMPLEMENTATION NOTE: The exact SDK method to append an entry is
// determined by Task 0 probe. If `appendToolResultEntry` doesn't exist,
// adapt to the actual method name (e.g. `addEntry` / `appendEntry`)
// or fall back to fs.appendFileSync + SessionManager.open reload.

import { FORK_PLACEHOLDER_RESULT } from "./boilerplate.js";

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name?: string;
  input?: unknown;
}

interface AssistantEntry {
  role: "assistant";
  content?: unknown[];
}

interface ToolResultEntry {
  role: "toolResult";
  toolCallId: string;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ForkSessionManagerLike {
  getEntries(): readonly unknown[];
  appendToolResultEntry(entry: ToolResultEntry): void;
}

function isAssistant(e: unknown): e is AssistantEntry {
  return typeof e === "object" && e !== null && (e as { role?: string }).role === "assistant";
}

function isToolUse(b: unknown): b is ToolUseBlock {
  return typeof b === "object" && b !== null && (b as { type?: string }).type === "tool_use";
}

function collectExistingToolResultIds(entries: readonly unknown[], afterIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let i = afterIndex + 1; i < entries.length; i++) {
    const e = entries[i] as { role?: string; toolCallId?: string };
    if (e?.role === "toolResult" && typeof e.toolCallId === "string") {
      ids.add(e.toolCallId);
    }
  }
  return ids;
}

export function injectForkPlaceholders(sm: ForkSessionManagerLike): void {
  const entries = sm.getEntries();
  if (entries.length === 0) return;

  // Find the last assistant entry; only its in-flight tool_uses matter.
  let lastAssistantIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isAssistant(entries[i])) {
      lastAssistantIdx = i;
      break;
    }
  }
  if (lastAssistantIdx === -1) return;

  const assistant = entries[lastAssistantIdx] as AssistantEntry;
  const toolUses = (assistant.content ?? []).filter(isToolUse);
  if (toolUses.length === 0) return;

  const resolved = collectExistingToolResultIds(entries, lastAssistantIdx);
  for (const tu of toolUses) {
    if (resolved.has(tu.id)) continue;
    sm.appendToolResultEntry({
      role: "toolResult",
      toolCallId: tu.id,
      content: [{ type: "text", text: FORK_PLACEHOLDER_RESULT }],
      isError: false,
    });
  }
}
```

- [ ] **Step 4: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/buildForkedMessages
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：7 tests，全仓 461。

- [ ] **Step 5: 提交**

```bash
git add extensions/localagent/buildForkedMessages.ts extensions/localagent/buildForkedMessages.test.ts
git commit -m "feat(localagent): inject placeholder tool_results into forked SM"
```

---

### Task 11: spawnLocalAgent + LocalAgentTask + kill

**Files:**
- Create: `extensions/localagent/spawnLocalAgent.ts`
- Create: `extensions/localagent/spawnLocalAgent.test.ts`
- Create: `extensions/localagent/localAgentTask.ts`
- Create: `extensions/localagent/localAgentTask.test.ts`
- Create: `extensions/localagent/kill.ts`
- Create: `extensions/localagent/kill.test.ts`

这是本期最大的 Task，约 350 行 prod / 450 行测试。

- [ ] **Step 1: 写 spawnLocalAgent 测试 (15 个测试场景)**

`extensions/localagent/spawnLocalAgent.test.ts`：

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnLocalAgent, _setSdkForTest } from "./spawnLocalAgent.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _clearOutputsForTest } from "../tasks/diskOutput.js";
import { _resetProgressForTest } from "./progress.js";
import { GENERAL_PURPOSE_AGENT, FORK_AGENT } from "./agentDefinitions/builtIn.js";
import type { LocalAgentTaskState } from "./types.js";

interface FakeSession {
  sessionId: string;
  messages: unknown[];
  isStreaming: boolean;
  emit(event: { type: string; [k: string]: unknown }): void;
  prompt: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  subscribe: (l: (e: unknown) => void) => () => void;
}

function makeFakeSession(): FakeSession {
  const listeners = new Set<(e: unknown) => void>();
  return {
    sessionId: "fake-sess",
    messages: [],
    isStreaming: false,
    emit(e) { for (const l of listeners) l(e); },
    prompt: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe(l) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

const fakePi: any = {
  events: {},
  sendMessage: vi.fn(),
  registerMessageRenderer: vi.fn(),
};

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  fakePi.sendMessage.mockClear();
  // SDK fakes default
  _setSdkForTest({
    createAgentSessionServices: vi.fn().mockResolvedValue({ cwd: "/tmp", agentDir: "/tmp/.pi", diagnostics: [] }),
    SessionManagerInMemory: vi.fn(() => ({ getSessionFile: () => undefined, getSessionId: () => "sm-fake" })),
    SessionManagerForkFrom: vi.fn(),
    createAgentSessionFromServices: vi.fn(async () => ({ session: makeFakeSession() })),
  });
});

afterEach(async () => {
  await _clearOutputsForTest();
});

describe("spawnLocalAgent — sync mode", () => {
  it("非 fork + 默认同步 → 等 agent_end 后返完整 result", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({})),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "say hi",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 60_000,
    });
    // 模拟 sub-session 生命周期事件
    await Promise.resolve();
    fake.emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
    fake.emit({ type: "agent_end", messages: [] });
    const result = await promise;
    expect(result.backgrounded).toBe(false);
    expect(result.status).toBe("completed");
    expect(result.finalText).toBe("hello");
    expect(fake.dispose).toHaveBeenCalled();
  });
});

describe("spawnLocalAgent — auto-background", () => {
  it("超过 timeoutMs 还未 agent_end → 返 backgrounded,sub 继续跑", async () => {
    vi.useFakeTimers();
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({})),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "long",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      timeoutMs: 100,
    });
    await Promise.resolve();
    vi.advanceTimersByTime(150);
    const result = await promise;
    vi.useRealTimers();
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
    expect(fake.dispose).not.toHaveBeenCalled();   // sub 仍在跑
    const t = store.getTask(result.taskId) as LocalAgentTaskState | undefined;
    expect(t?.isBackgrounded).toBe(true);
  });
});

describe("spawnLocalAgent — explicit background", () => {
  it("forceBackground=true → 立即返 backgrounded,timeoutMs 被忽略", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({})),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "explicit",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      forceBackground: true,
      timeoutMs: 999_999,
    });
    expect(result.backgrounded).toBe(true);
    expect(result.status).toBe("running");
  });
});

describe("spawnLocalAgent — fork path", () => {
  it("agentDef === FORK_AGENT 但缺 parentSessionFile → throw", async () => {
    const store = createTaskStore();
    await expect(
      spawnLocalAgent(fakePi, store, {
        prompt: "x",
        agentDef: FORK_AGENT,
        ctxMessages: [],
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/persisted parent session/);
  });

  it("fork 路径强制后台 + 用 forkFrom 取 SM + injectPlaceholders + boilerplate prompt", async () => {
    const fake = makeFakeSession();
    const forkFromMock = vi.fn(() => ({
      getEntries: () => [],
      appendToolResultEntry: vi.fn(),
      getSessionFile: () => "/tmp/forked.jsonl",
      getSessionId: () => "forked",
    }));
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(),
      SessionManagerForkFrom: forkFromMock,
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "find auth bugs",
      agentDef: FORK_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
      parentSessionFile: "/tmp/parent.jsonl",
    });
    expect(forkFromMock).toHaveBeenCalledWith("/tmp/parent.jsonl", "/tmp");
    expect(result.backgrounded).toBe(true);
    expect(fake.prompt).toHaveBeenCalled();
    const promptArg = fake.prompt.mock.calls[0]![0] as string;
    expect(promptArg).toContain("<fork_boilerplate>");
    expect(promptArg).toContain("find auth bugs");
  });
});

describe("spawnLocalAgent — recursion guard", () => {
  it("ctxMessages 含 boilerplate tag → throw", async () => {
    const store = createTaskStore();
    await expect(
      spawnLocalAgent(fakePi, store, {
        prompt: "x",
        agentDef: GENERAL_PURPOSE_AGENT,
        ctxMessages: [
          { role: "user", content: [{ type: "text", text: "<fork_boilerplate>STOP</fork_boilerplate>" }] },
        ],
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/inside a forked worker/i);
  });
});

describe("spawnLocalAgent — registerTask state shape", () => {
  it("registerTask 写入 LocalAgentTaskState,type=local_agent,status=running", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({})),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const promise = spawnLocalAgent(fakePi, store, {
      prompt: "x",
      agentDef: GENERAL_PURPOSE_AGENT,
      ctxMessages: [],
      cwd: "/tmp",
    });
    await Promise.resolve();
    const tasks = Object.values(store.get());
    expect(tasks).toHaveLength(1);
    const t = tasks[0] as LocalAgentTaskState;
    expect(t.type).toBe("local_agent");
    expect(t.status).toBe("running");
    expect(t.isFork).toBe(false);
    expect(t.session).toBe(fake);
    fake.emit({ type: "agent_end", messages: [] });
    await promise;
  });
});

describe("spawnLocalAgent — agentDef.background=true", () => {
  it("agentDef.background=true → 等价 forceBackground", async () => {
    const fake = makeFakeSession();
    _setSdkForTest({
      createAgentSessionServices: vi.fn().mockResolvedValue({}),
      SessionManagerInMemory: vi.fn(() => ({})),
      SessionManagerForkFrom: vi.fn(),
      createAgentSessionFromServices: vi.fn(async () => ({ session: fake })),
    });
    const store = createTaskStore();
    const result = await spawnLocalAgent(fakePi, store, {
      prompt: "x",
      agentDef: { ...GENERAL_PURPOSE_AGENT, background: true },
      ctxMessages: [],
      cwd: "/tmp",
    });
    expect(result.backgrounded).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试,确认 RED**

```bash
npm test -- extensions/localagent/spawnLocalAgent
```

- [ ] **Step 3: 实现 spawnLocalAgent**

`extensions/localagent/spawnLocalAgent.ts`：

```ts
import {
  type ExtensionAPI,
  createAgentSessionServices as _createAgentSessionServices,
  createAgentSessionFromServices as _createAgentSessionFromServices,
  SessionManager as _SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../tasks/taskStore.js";
import { createTaskStateBase, generateTaskId, type Task, type TaskStateBase } from "../tasks/Task.js";
import { registerTask, updateTaskState } from "../tasks/framework.js";
import { appendTaskOutput, evictTaskOutput, flushTaskOutput, initTaskOutput } from "../tasks/diskOutput.js";
import { getTaskOutputPath } from "../tasks/outputPath.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { logError } from "../tasks/logging.js";
import type { AgentDefinition, LocalAgentTaskState } from "./types.js";
import { FORK_AGENT_TYPE } from "./agentDefinitions/builtIn.js";
import { isInForkChild } from "./recursionGuard.js";
import { buildChildDirective } from "./boilerplate.js";
import { injectForkPlaceholders, type ForkSessionManagerLike } from "./buildForkedMessages.js";
import { resolveSubAgentTools } from "./toolPool.js";
import { translateAgentEvent } from "./outputTranslator.js";
import { initProgress, recordToolStart, addTokens, getProgress, removeProgress } from "./progress.js";

// SDK injection layer for tests.
interface SdkBindings {
  createAgentSessionServices: typeof _createAgentSessionServices;
  SessionManagerInMemory: (cwd: string) => unknown;
  SessionManagerForkFrom: (parent: string, cwd: string) => unknown;
  createAgentSessionFromServices: typeof _createAgentSessionFromServices;
}

let _sdk: SdkBindings = {
  createAgentSessionServices: _createAgentSessionServices,
  SessionManagerInMemory: (cwd) => _SessionManager.inMemory(cwd),
  SessionManagerForkFrom: (parent, cwd) => _SessionManager.forkFrom(parent, cwd),
  createAgentSessionFromServices: _createAgentSessionFromServices,
};

export function _setSdkForTest(sdk: Partial<SdkBindings>): void {
  _sdk = { ..._sdk, ...sdk };
}

export interface SpawnLocalAgentOptions {
  prompt: string;
  agentDef: AgentDefinition;
  ctxMessages: readonly unknown[];
  cwd: string;
  description?: string;
  toolUseId?: string;
  model?: string;
  timeoutMs?: number;
  forceBackground?: boolean;
  parentSessionFile?: string;
  allRegisteredTools?: readonly string[];
}

export interface SpawnLocalAgentResult {
  taskId: string;
  status: "completed" | "failed" | "killed" | "running";
  backgrounded: boolean;
  finalText?: string;
  toolCallCount: number;
  tokenCount: number;
  agentType: string;
  outputFile: string;
  durationMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export async function spawnLocalAgent(
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalAgentOptions,
): Promise<SpawnLocalAgentResult> {
  // recursion guard
  if (isInForkChild(opts.ctxMessages)) {
    throw new Error("Fork is not available inside a forked worker. Complete your task directly using your tools.");
  }

  const isFork = opts.agentDef.agentType === FORK_AGENT_TYPE;
  const forceBg = opts.forceBackground === true || opts.agentDef.background === true || isFork;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (isFork && !opts.parentSessionFile) {
    throw new Error("Fork requires a persisted parent session. Run pi without --no-session.");
  }

  // services
  const services = await _sdk.createAgentSessionServices({ cwd: opts.cwd });

  // SessionManager
  let sm: unknown;
  if (isFork) {
    sm = _sdk.SessionManagerForkFrom(opts.parentSessionFile!, opts.cwd);
    injectForkPlaceholders(sm as ForkSessionManagerLike);
  } else {
    sm = _sdk.SessionManagerInMemory(opts.cwd);
  }

  // tool pool
  const tools = resolveSubAgentTools(opts.agentDef, opts.allRegisteredTools ?? []);

  // sub-session
  const { session } = await _sdk.createAgentSessionFromServices({
    services: services as never,
    sessionManager: sm as never,
    tools,
  });

  const taskId = generateTaskId("local_agent");
  const outputFile = getTaskOutputPath(taskId);
  initProgress(taskId, Date.now());

  // register task BEFORE prompt so kill/status can find it
  const initial: LocalAgentTaskState = {
    ...createTaskStateBase({
      id: taskId,
      type: "local_agent",
      description: opts.description ?? opts.prompt.slice(0, 60),
      outputFile,
      toolUseId: opts.toolUseId,
    }),
    type: "local_agent",
    status: "running",
    prompt: opts.prompt,
    agentType: opts.agentDef.agentType,
    model: opts.model,
    isBackgrounded: false,
    isFork,
    forkParentSessionFile: opts.parentSessionFile,
    session,
  };
  registerTask(initial, store);

  void initTaskOutput(taskId).catch((e: unknown) => {
    if (typeof e === "object" && e !== null && "code" in e && (e as { code: unknown }).code === "EEXIST") return;
    logError(e, "initTaskOutput race");
  });

  let turnCount = 0;
  let toolCount = 0;
  let agentEndedResolve: () => void;
  const agentEnded = new Promise<void>((resolve) => { agentEndedResolve = resolve; });
  let lastFinalText = "";

  const unsub = session.subscribe((event: unknown) => {
    const e = event as { type: string; toolName?: string; message?: { role?: string; usage?: { totalTokens?: number } } };
    if (e.type === "tool_execution_start") {
      toolCount += 1;
      if (e.toolName) recordToolStart(taskId, e.toolName);
    }
    if (e.type === "turn_start") turnCount += 1;
    if (e.type === "message_end" && e.message?.role === "assistant") {
      // 如果 probe 显示是 incremental, addTokens delta;cumulative 改 setTokens
      const delta = e.message?.usage?.totalTokens ?? 0;
      if (delta > 0) addTokens(taskId, delta);
      const m = e.message as { content?: unknown };
      if (Array.isArray(m.content)) {
        const txt = m.content
          .filter((b): b is { type: string; text?: string } => typeof b === "object" && b !== null && "type" in b)
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("");
        if (txt) lastFinalText = txt;
      }
    }
    try {
      translateAgentEvent(event as never, (line) => appendTaskOutput(taskId, line), { turnCount, toolCount });
    } catch (err) {
      logError(err, "translateAgentEvent");
    }
    if (e.type === "agent_end") {
      agentEndedResolve();
    }
  });

  const cleanup = (): void => {
    try { unsub(); } catch {/* ignore */}
  };
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({ ...cur, cleanup }));

  // start prompt
  const promptText = isFork ? buildChildDirective(opts.prompt) : opts.prompt;
  const promptPromise = session.prompt(promptText).catch((e) => {
    logError(e, "session.prompt");
  });

  // ---- background path ----
  if (forceBg) {
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({ ...cur, isBackgrounded: true }));
    void runBackgroundFinalizer();
    return {
      taskId,
      status: "running",
      backgrounded: true,
      toolCallCount: getProgress(taskId)?.toolCallCount ?? 0,
      tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      agentType: opts.agentDef.agentType,
      outputFile,
    };
  }

  // ---- sync + auto-background race ----
  let resolved = false;
  const timer = setTimeout(() => {
    if (resolved) return;
    resolved = true;
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({ ...cur, isBackgrounded: true }));
    void runBackgroundFinalizer();
  }, timeoutMs);

  await Promise.race([agentEnded, new Promise<void>((resolve) => {
    const inner = setInterval(() => {
      if (resolved) {
        clearInterval(inner);
        resolve();
      }
    }, 50);
  })]);
  clearTimeout(timer);

  if (resolved) {
    // auto-bg already set up; promise above resolved when timeout fired
    return {
      taskId,
      status: "running",
      backgrounded: true,
      toolCallCount: getProgress(taskId)?.toolCallCount ?? 0,
      tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      agentType: opts.agentDef.agentType,
      outputFile,
    };
  }
  resolved = true;

  // sync finalize
  await promptPromise;
  cleanup();
  await flushTaskOutput(taskId);
  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    status: "completed",
    endTime: Date.now(),
    result: {
      finalText: lastFinalText,
      toolCallCount: toolCount,
      tokenCount: getProgress(taskId)?.tokenCount ?? 0,
    },
  }));
  notifyTaskTerminal(pi, store, {
    taskId,
    taskType: "local_agent",
    status: "completed",
    description: opts.description ?? opts.prompt.slice(0, 60),
    outputFile,
    toolUseId: opts.toolUseId,
    extra: { agentType: opts.agentDef.agentType, ...getProgress(taskId) },
  });
  session.dispose();
  removeProgress(taskId);
  void evictTaskOutput(taskId);

  return {
    taskId,
    status: "completed",
    backgrounded: false,
    finalText: lastFinalText,
    toolCallCount: toolCount,
    tokenCount: getProgress(taskId)?.tokenCount ?? 0,
    agentType: opts.agentDef.agentType,
    outputFile,
    durationMs: Date.now() - initial.startTime,
  };

  async function runBackgroundFinalizer(): Promise<void> {
    await agentEnded;
    await promptPromise;
    cleanup();
    await flushTaskOutput(taskId);
    const t = store.getTask(taskId);
    if (!t || t.status !== "running") return;
    updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
      ...cur,
      status: "completed",
      endTime: Date.now(),
      result: {
        finalText: lastFinalText,
        toolCallCount: toolCount,
        tokenCount: getProgress(taskId)?.tokenCount ?? 0,
      },
    }));
    notifyTaskTerminal(pi, store, {
      taskId,
      taskType: "local_agent",
      status: "completed",
      description: opts.description ?? opts.prompt.slice(0, 60),
      outputFile,
      toolUseId: opts.toolUseId,
      triggerTurn: true,
      extra: { agentType: opts.agentDef.agentType, ...getProgress(taskId) },
    });
    session.dispose();
    removeProgress(taskId);
    void evictTaskOutput(taskId);
  }
}
```

- [ ] **Step 4: GREEN**

```bash
npm test -- extensions/localagent/spawnLocalAgent
```

预期：8 tests pass。

- [ ] **Step 5: 写 kill 测试**

`extensions/localagent/kill.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { killLocalAgentTask } from "./kill.js";
import { createTaskStore } from "../tasks/taskStore.js";
import { _setDefaultTaskStoreForTest } from "../tasks/taskStore.js";
import { _resetTaskOutputDirForTest } from "../tasks/outputPath.js";
import { _resetProgressForTest, initProgress } from "./progress.js";
import { registerTask } from "../tasks/framework.js";
import { createTaskStateBase } from "../tasks/Task.js";
import type { LocalAgentTaskState } from "./types.js";

const fakePi: any = { events: {}, sendMessage: vi.fn() };

beforeEach(() => {
  _setDefaultTaskStoreForTest(createTaskStore());
  _resetTaskOutputDirForTest();
  _resetProgressForTest();
  fakePi.sendMessage.mockClear();
});

function makeRunningTask(taskId: string): { state: LocalAgentTaskState; abort: any; dispose: any; cleanup: any } {
  const abort = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const cleanup = vi.fn();
  const state: LocalAgentTaskState = {
    ...createTaskStateBase({
      id: taskId, type: "local_agent", description: "x",
      outputFile: `/tmp/${taskId}.output`,
    }),
    type: "local_agent",
    status: "running",
    prompt: "x",
    agentType: "general-purpose",
    isBackgrounded: false,
    isFork: false,
    session: { abort, dispose } as any,
    cleanup,
  };
  return { state, abort, dispose, cleanup };
}

describe("killLocalAgentTask", () => {
  it("不存在的 task → no-op", async () => {
    const store = createTaskStore();
    await killLocalAgentTask(fakePi, store, "nope");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("已 terminal 的 task → no-op", async () => {
    const store = createTaskStore();
    const { state } = makeRunningTask("a1");
    state.status = "completed";
    registerTask(state, store);
    await killLocalAgentTask(fakePi, store, "a1");
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });

  it("running task → status=killed,abort+cleanup+dispose 顺序: abort → cleanup → dispose,然后 notify", async () => {
    const store = createTaskStore();
    const { state, abort, dispose, cleanup } = makeRunningTask("a2");
    initProgress("a2", 0);
    registerTask(state, store);
    const order: string[] = [];
    abort.mockImplementation(async () => { order.push("abort"); });
    cleanup.mockImplementation(() => { order.push("cleanup"); });
    dispose.mockImplementation(() => { order.push("dispose"); });
    fakePi.sendMessage.mockImplementation(() => { order.push("notify"); });

    await killLocalAgentTask(fakePi, store, "a2");
    expect(store.getTask("a2")?.status).toBe("killed");
    expect(order).toEqual(["abort", "cleanup", "dispose", "notify"]);
  });

  it("abort throw 也不阻断后续清理", async () => {
    const store = createTaskStore();
    const { state, abort, dispose, cleanup } = makeRunningTask("a3");
    abort.mockRejectedValue(new Error("boom"));
    registerTask(state, store);
    await killLocalAgentTask(fakePi, store, "a3");
    expect(cleanup).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalled();
    expect(store.getTask("a3")?.status).toBe("killed");
  });
});
```

- [ ] **Step 6: RED**

```bash
npm test -- extensions/localagent/kill
```

- [ ] **Step 7: 实现 kill.ts**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../tasks/taskStore.js";
import { isTerminalTaskStatus } from "../tasks/Task.js";
import { updateTaskState } from "../tasks/framework.js";
import { evictTaskOutput, flushTaskOutput } from "../tasks/diskOutput.js";
import { notifyTaskTerminal } from "../tasks/notifications.js";
import { logError } from "../tasks/logging.js";
import type { LocalAgentTaskState } from "./types.js";
import { getProgress, removeProgress } from "./progress.js";

/**
 * Kill order (sequence-sensitive):
 *   1. updateTaskState 'killed'  — outputTranslator sees terminal flag
 *   2. session.abort() — wait for SDK abort to settle (best-effort)
 *   3. cleanup()       — unsubscribe BEFORE dispose, otherwise the unsub
 *                        becomes no-op (dispose clears listeners internally)
 *   4. session.dispose() — release SDK resources
 *   5. notifyTaskTerminal — store-only read, session may be gone
 *   6. evictTaskOutput
 */
export async function killLocalAgentTask(
  pi: ExtensionAPI,
  store: TaskStore,
  taskId: string,
): Promise<void> {
  const t = store.getTask(taskId) as LocalAgentTaskState | undefined;
  if (!t || isTerminalTaskStatus(t.status)) return;

  updateTaskState<LocalAgentTaskState>(taskId, store, (cur) => ({
    ...cur,
    status: "killed",
    endTime: Date.now(),
  }));

  if (t.session) {
    try { await t.session.abort(); } catch (e) { logError(e, "killLocalAgent abort"); }
  }
  try { t.cleanup?.(); } catch (e) { logError(e, "killLocalAgent cleanup"); }
  try { t.session?.dispose(); } catch (e) { logError(e, "killLocalAgent dispose"); }
  try { await flushTaskOutput(taskId); } catch (e) { logError(e, "killLocalAgent flush"); }

  notifyTaskTerminal(pi, store, {
    taskId,
    taskType: "local_agent",
    status: "killed",
    description: t.description,
    outputFile: t.outputFile,
    toolUseId: t.toolUseId,
    triggerTurn: true,
    extra: { agentType: t.agentType, ...getProgress(taskId) },
  });
  removeProgress(taskId);
  void evictTaskOutput(taskId);
}
```

- [ ] **Step 8: GREEN**

```bash
npm test -- extensions/localagent/kill
```

- [ ] **Step 9: 写 LocalAgentTask 测试 + 实现**

`extensions/localagent/localAgentTask.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  LocalAgentTask,
  _bindPi,
  _unbindPi,
  _resetLocalAgentPiBindingForTest,
} from "./localAgentTask.js";
import { createTaskStore } from "../tasks/taskStore.js";

const fakePi: any = { events: {}, sendMessage: vi.fn() };

beforeEach(() => {
  _resetLocalAgentPiBindingForTest();
  fakePi.sendMessage.mockClear();
});

describe("LocalAgentTask", () => {
  it("name='LocalAgentTask',type='local_agent'", () => {
    expect(LocalAgentTask.name).toBe("LocalAgentTask");
    expect(LocalAgentTask.type).toBe("local_agent");
  });

  it("kill 调用前未 bind pi → throw", async () => {
    const store = createTaskStore();
    await expect(LocalAgentTask.kill("a1", store)).rejects.toThrow(/pi.*bound/i);
  });

  it("bind 后 kill 委托给 killLocalAgentTask(no-op for missing task)", async () => {
    _bindPi(fakePi);
    const store = createTaskStore();
    await LocalAgentTask.kill("nope", store as any);
    expect(fakePi.sendMessage).not.toHaveBeenCalled();
  });
});
```

`extensions/localagent/localAgentTask.ts`：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Task, TaskStoreLike } from "../tasks/Task.js";
import type { TaskStore } from "../tasks/taskStore.js";
import { killLocalAgentTask } from "./kill.js";

let _currentPi: ExtensionAPI | undefined;

export function _bindPi(pi: ExtensionAPI): void { _currentPi = pi; }
export function _unbindPi(): void { _currentPi = undefined; }
export function _resetLocalAgentPiBindingForTest(): void { _currentPi = undefined; }
export function _getPi(): ExtensionAPI {
  if (!_currentPi) throw new Error("LocalAgentTask called before extension session_start (pi not bound)");
  return _currentPi;
}

export const LocalAgentTask: Task = {
  name: "LocalAgentTask",
  type: "local_agent",
  async kill(taskId: string, store: TaskStoreLike): Promise<void> {
    await killLocalAgentTask(_getPi(), store as TaskStore, taskId);
  },
};
```

- [ ] **Step 10: GREEN + typecheck + 全仓**

```bash
npm test -- extensions/localagent/localAgentTask extensions/localagent/spawnLocalAgent extensions/localagent/kill
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：8 + 4 + 3 = 15 tests，全仓 476。

- [ ] **Step 11: 提交**

```bash
git add extensions/localagent/spawnLocalAgent.ts extensions/localagent/spawnLocalAgent.test.ts extensions/localagent/localAgentTask.ts extensions/localagent/localAgentTask.test.ts extensions/localagent/kill.ts extensions/localagent/kill.test.ts
git commit -m "feat(localagent): spawnLocalAgent (3 modes) + LocalAgentTask + kill"
```

---

### Task 12: task_agent tool + extension entrypoint + spike 清理

**Files:**
- Create: `extensions/localagent/tools/taskAgent.ts`
- Create: `extensions/localagent/tools/taskAgent.test.ts`
- Create: `extensions/localagent/index.ts`
- Create: `extensions/localagent/index.test.ts`
- Delete: `extensions/spike-localagent/`
- Delete: `extensions/spike-fork/`
- Delete: `extensions/localagent/_spike/`

- [ ] **Step 1: 写 task_agent tool 测试**

`extensions/localagent/tools/taskAgent.test.ts`：

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildTaskAgentTool, _setSpawnerForTest } from "./taskAgent.js";
import { createTaskStore } from "../../tasks/taskStore.js";

const fakePi: any = { events: {}, sendMessage: vi.fn(), getActiveTools: () => [] };
const fakeCtx: any = {
  cwd: "/tmp",
  sessionManager: { getSessionFile: () => "/tmp/parent.jsonl" },
  model: { id: "opus", provider: "anthropic" },
  messages: [],
};

beforeEach(() => {
  fakePi.sendMessage.mockClear();
  _setSpawnerForTest(undefined);
});

async function callTool(tool: ReturnType<typeof buildTaskAgentTool>, params: unknown, ctxOverride?: any) {
  return await tool.execute("call-1", params as never, new AbortController().signal, () => {}, { ...fakeCtx, ...ctxOverride });
}

describe("task_agent tool", () => {
  it("tool name + parameters 存在", () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    expect(tool.name).toBe("task_agent");
    expect(tool.parameters).toBeDefined();
  });

  it("subagent_type 不存在 → isError + 列出可用名", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "no_such" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/no_such/);
    expect(text).toMatch(/general-purpose/);
  });

  it("isolation: 'worktree' → isError 'not yet supported'", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", isolation: "worktree" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/not yet supported/i);
  });

  it("subagent_type 省略 + 父 session 有文件 → fork 路径,返 backgrounded", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "running", backgrounded: true, agentType: "__fork__",
      toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "do it" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/Backgrounded/);
    expect(text).toMatch(/a1/);
  });

  it("subagent_type 省略 + 父 session 无文件 → isError", async () => {
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y" }, {
      sessionManager: { getSessionFile: () => undefined },
    });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/--no-session/);
  });

  it("同步路径 → 返 finalText", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "全部找到了", toolCallCount: 5, tokenCount: 1200, outputFile: "/tmp/a1.out", durationMs: 8000,
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toBe("全部找到了");
  });

  it("run_in_background:true → 返 backgrounded 即使没 fork", async () => {
    const spawnerMock = vi.fn().mockResolvedValue({
      taskId: "a1", status: "running", backgrounded: true, agentType: "general-purpose",
      toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawnerMock);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", run_in_background: true });
    expect(spawnerMock.mock.calls[0]![0]!.forceBackground).toBe(true);
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/Backgrounded/);
  });

  it("model='opus' 透传到 spawner", async () => {
    const spawnerMock = vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "ok", toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    });
    _setSpawnerForTest(spawnerMock);
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose", model: "opus" });
    expect(spawnerMock.mock.calls[0]![0]!.model).toBe("opus");
  });

  it("spawner throw → tool 返 isError + stack 摘要", async () => {
    _setSpawnerForTest(vi.fn().mockRejectedValue(new Error("boom")));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    const text = (r.content[0] as any)!.text as string;
    expect(text).toMatch(/boom/);
  });

  it("details.action='task_agent' + taskId 在 details 里", async () => {
    _setSpawnerForTest(vi.fn().mockResolvedValue({
      taskId: "a1", status: "completed", backgrounded: false, agentType: "general-purpose",
      finalText: "ok", toolCallCount: 0, tokenCount: 0, outputFile: "/tmp/a1.out",
    }));
    const tool = buildTaskAgentTool(fakePi, createTaskStore());
    const r = await callTool(tool, { description: "x", prompt: "y", subagent_type: "general-purpose" });
    expect((r.details as any)!.action).toBe("task_agent");
    expect((r.details as any)!.taskId).toBe("a1");
  });
});
```

- [ ] **Step 2: RED**

```bash
npm test -- extensions/localagent/tools/taskAgent
```

- [ ] **Step 3: 实现 task_agent tool**

`extensions/localagent/tools/taskAgent.ts`：

```ts
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskStore } from "../../tasks/taskStore.js";
import { spawnLocalAgent as _spawn, type SpawnLocalAgentOptions, type SpawnLocalAgentResult } from "../spawnLocalAgent.js";
import { getBuiltInAgents, FORK_AGENT } from "../agentDefinitions/builtIn.js";
import { mergeAgentDefinitions, getAgentDefinition } from "../agentDefinitions/resolve.js";
import { loadAgentsFromDir } from "../agentDefinitions/loadFromDisk.js";
import { homedir } from "node:os";
import { join } from "node:path";

type Spawner = (
  pi: ExtensionAPI,
  store: TaskStore,
  opts: SpawnLocalAgentOptions,
) => Promise<SpawnLocalAgentResult>;
let _spawner: Spawner = _spawn;
export function _setSpawnerForTest(s: Spawner | undefined): void {
  _spawner = s ?? _spawn;
}

const TaskAgentParams = Type.Object({
  description: Type.String({ description: "Short (3-5 word) task description for status displays." }),
  prompt: Type.String({ description: "The task for the agent to perform." }),
  subagent_type: Type.Optional(Type.String({ description: "Type of specialized agent. Omit to fork (inherits parent context)." })),
  model: Type.Optional(Type.Union([Type.Literal("sonnet"), Type.Literal("opus"), Type.Literal("haiku")])),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run as background task; main agent gets a notification on completion." })),
  cwd: Type.Optional(Type.String({ description: "Override working directory for the sub-agent." })),
  isolation: Type.Optional(Type.Literal("worktree", { description: "Reserved; not implemented." })),
});

interface TaskAgentDetails {
  action: "task_agent";
  taskId?: string;
  agentType?: string;
  status?: string;
  isBackgrounded?: boolean;
  toolCallCount?: number;
  tokenCount?: number;
}

export function buildTaskAgentTool(
  pi: ExtensionAPI,
  store: TaskStore,
): ToolDefinition<typeof TaskAgentParams, TaskAgentDetails> {
  return {
    name: "task_agent",
    label: "Run sub-agent",
    description:
      "Dispatch an in-process sub-agent (LLM) to perform a focused task. Pass subagent_type to pick a built-in or user-defined agent; omit subagent_type to fork (inherits the full conversation context). Long-running tasks auto-background after 120s.",
    parameters: TaskAgentParams,
    executionMode: "parallel",
    async execute(_callId: unknown, raw: unknown, _signal, _onUpdate, ctx: ExtensionContext) {
      const params = raw as {
        description: string;
        prompt: string;
        subagent_type?: string;
        model?: "sonnet" | "opus" | "haiku";
        run_in_background?: boolean;
        cwd?: string;
        isolation?: "worktree";
      };
      if (params.isolation === "worktree") {
        return errResult("isolation 'worktree' not yet supported in this phase");
      }

      // Load agent definitions: built-in + ~/.pi/agents + cwd/.pi/agents
      const cwd = params.cwd ?? ctx.cwd;
      const userDefs = await loadAgentsFromDir(join(homedir(), ".pi", "agents"), "user");
      const projDefs = await loadAgentsFromDir(join(cwd, ".pi", "agents"), "project");
      const allDefs = mergeAgentDefinitions(getBuiltInAgents(), userDefs, projDefs);

      let agentDef;
      let parentSessionFile: string | undefined;
      if (params.subagent_type === undefined) {
        // fork path
        agentDef = FORK_AGENT;
        parentSessionFile = ctx.sessionManager.getSessionFile();
        if (!parentSessionFile) {
          return errResult(
            "Fork requires a persisted parent session. Run pi without --no-session.",
          );
        }
      } else {
        agentDef = getAgentDefinition(allDefs, params.subagent_type);
        if (!agentDef) {
          const available = allDefs.map((d) => d.agentType).sort().join(", ");
          return errResult(`Unknown subagent_type "${params.subagent_type}". Available: ${available}`);
        }
      }

      try {
        const result = await _spawner(pi, store, {
          prompt: params.prompt,
          agentDef,
          ctxMessages: (ctx as { messages?: readonly unknown[] }).messages ?? [],
          cwd,
          description: params.description,
          model: params.model,
          forceBackground: params.run_in_background === true,
          parentSessionFile,
          allRegisteredTools: pi.getActiveTools(),
        });
        if (result.backgrounded) {
          return {
            content: [{
              type: "text",
              text: `Backgrounded (taskId=${result.taskId}, agentType=${result.agentType}). Use task_status to query, task_kill to abort.`,
            }],
            details: {
              action: "task_agent",
              taskId: result.taskId,
              agentType: result.agentType,
              status: "running",
              isBackgrounded: true,
              toolCallCount: result.toolCallCount,
              tokenCount: result.tokenCount,
            },
          };
        }
        return {
          content: [{ type: "text", text: result.finalText ?? "" }],
          details: {
            action: "task_agent",
            taskId: result.taskId,
            agentType: result.agentType,
            status: result.status,
            isBackgrounded: false,
            toolCallCount: result.toolCallCount,
            tokenCount: result.tokenCount,
          },
        };
      } catch (e) {
        return errResult(`task_agent failed: ${(e as Error).message ?? String(e)}`);
      }
    },
  };
}

function errResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
    details: { action: "task_agent" as const },
  };
}
```

- [ ] **Step 4: GREEN**

```bash
npm test -- extensions/localagent/tools/taskAgent
```

- [ ] **Step 5: 写 entrypoint 测试**

`extensions/localagent/index.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import localagentExtension from "./index.js";

const fakeHandle = {
  store: { get: () => ({}), getTask: () => undefined } as any,
  registerTaskType: vi.fn(),
  getTaskType: vi.fn(),
  unregisterTaskType: vi.fn(),
};

const fakePi: any = {
  events: { __pi_tasks_handle__: fakeHandle },
  on: vi.fn(),
  registerTool: vi.fn(),
  registerFlag: vi.fn(),
  getActiveTools: vi.fn(() => ["read", "bash", "task_agent"]),
  setActiveTools: vi.fn(),
  sendMessage: vi.fn(),
};

beforeEach(() => {
  fakePi.on.mockClear();
  fakePi.registerTool.mockClear();
  fakeHandle.registerTaskType.mockClear();
  fakeHandle.unregisterTaskType.mockClear();
});

describe("localagent extension", () => {
  it("绑两个事件 hooks", () => {
    localagentExtension(fakePi);
    const events = fakePi.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("session_start");
    expect(events).toContain("session_shutdown");
  });

  it("session_start 调 registerTaskType('local_agent', LocalAgentTask) + registerTool('task_agent')", async () => {
    localagentExtension(fakePi);
    const startHandler = fakePi.on.mock.calls.find((c: any[]) => c[0] === "session_start")![1];
    await startHandler({}, { cwd: "/tmp", sessionManager: { getSessionFile: () => undefined } });
    expect(fakeHandle.registerTaskType).toHaveBeenCalledWith("local_agent", expect.objectContaining({ name: "LocalAgentTask" }));
    expect(fakePi.registerTool).toHaveBeenCalledWith(expect.objectContaining({ name: "task_agent" }));
  });

  it("session_shutdown 调 unregisterTaskType('local_agent')", async () => {
    localagentExtension(fakePi);
    const shutdownHandler = fakePi.on.mock.calls.find((c: any[]) => c[0] === "session_shutdown")![1];
    await shutdownHandler();
    expect(fakeHandle.unregisterTaskType).toHaveBeenCalledWith("local_agent");
  });
});
```

- [ ] **Step 6: RED**

```bash
npm test -- extensions/localagent/index
```

- [ ] **Step 7: 实现 entrypoint**

`extensions/localagent/index.ts`：

```ts
// pi-localagent-extension — registers `task_agent` tool + `local_agent` task type.
//
// Loading order: "localagent" > "localshell" > "tasks" by directory dict order,
// so by the time we run, both tasks (handle attached) and localshell are loaded.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getTasksHandle } from "../tasks/handle.js";
import { getRunningTasks } from "../tasks/framework.js";
import { LocalAgentTask, _bindPi, _unbindPi } from "./localAgentTask.js";
import { buildTaskAgentTool } from "./tools/taskAgent.js";

export default function localagentExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const handle = getTasksHandle(pi);
    _bindPi(pi);
    handle.registerTaskType("local_agent", LocalAgentTask);
    pi.registerTool(buildTaskAgentTool(pi, handle.store));
  });

  pi.on("session_shutdown", async () => {
    const handle = getTasksHandle(pi);
    const running = getRunningTasks(handle.store.get()).filter((t) => t.type === "local_agent");
    await Promise.all(running.map((t) => LocalAgentTask.kill(t.id, handle.store)));
    handle.unregisterTaskType("local_agent");
    _unbindPi();
  });
}
```

- [ ] **Step 8: GREEN**

```bash
npm test -- extensions/localagent/index
```

- [ ] **Step 9: 删 spike 目录**

```bash
git rm -rf extensions/spike-localagent extensions/spike-fork
git rm -rf extensions/localagent/_spike
```

- [ ] **Step 10: 全仓 typecheck + 全仓测试**

```bash
npx tsc --noEmit
npm test 2>&1 | tail -3
```

预期：391（A+B 期 baseline 不动）+ 75 新增 ≈ 466 passing。

- [ ] **Step 11: 真实 LLM 端到端验证（如有 token）**

```bash
# 同步路径
pi --no-extensions -e . -p "用 task_agent 调 explore agent,prompt='找一下当前目录里 task_agent 的源码定义在哪个文件',subagent_type='explore'"

# fork 路径 (保持有 session 文件)
pi --no-extensions -e . -p "我喜欢深圳。然后用 task_agent (省略 subagent_type 走 fork),prompt='根据上下文,用一句话告诉我我喜欢哪个城市'"
```

预期：第 1 条返回 explore agent 的同步结果含文件名；第 2 条返回 "Backgrounded(taskId=...)",几秒后通知出现且 LLM 自动跑下一轮回答 "深圳"。

- [ ] **Step 12: 提交**

```bash
git add extensions/localagent/tools/taskAgent.ts extensions/localagent/tools/taskAgent.test.ts extensions/localagent/index.ts extensions/localagent/index.test.ts docs/superpowers/specs/2026-06-02-localagent-task-design.md docs/superpowers/plans/2026-06-02-localagent-task.md
git commit -m "feat(localagent): task_agent tool + extension entrypoint + spike cleanup

C 期完整交付:
- 进程内 sub-AgentSession (createAgentSessionFromServices)
- 三态执行 (sync default / auto-bg 120s / explicit bg)
- fork 路径 (forkFrom + 占位 tool_result + boilerplate)
- agent 定义 (built-in + user-level + project-level markdown)
- 工具池白名单 (agent-defined + 永远剔除 task_agent 防递归)
- 输出转译 (subscribe → outputFile)
- 完整接入 A 期 task framework (kill/status/list/notifyTaskTerminal)
- spec docs/superpowers/specs/2026-06-02-localagent-task-design.md
- plan docs/superpowers/plans/2026-06-02-localagent-task.md

Tests: 466 (391 baseline + 75 new). Typecheck clean."
```

---

## 验收清单

- [ ] vitest 391 + 75 = 466 全绿
- [ ] typecheck 干净
- [ ] `extensions/spike-*` 全部删除
- [ ] `extensions/localagent/_spike/` 删除
- [ ] (token 恢复后) 真 LLM 端到端跑通同步 + fork 两条路径
- [ ] git log 12 个干净 commit

## Out of Scope (推到 D/E 期)

- ❌ worktree / remote isolation
- ❌ name / team_name / mode 等 multi-agent 参数
- ❌ in-process teammate 长期对话(D 期主题)
- ❌ skills 预加载 / memory / hooks / mcpServers / requiredMcpServers / criticalSystemReminder_EXPERIMENTAL
- ❌ resume agent / fork-from-leaf-id
- ❌ 同步模式中途进度推送给主 LLM
- ❌ 主 LLM 中途 SendMessage 给后台 sub
