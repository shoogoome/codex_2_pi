# LocalAgent Task (`local_agent`) 设计文档

## 摘要

复刻 Claude Code 的 `local_agent` task 类型 + `Task` 工具（在 Pi 中命名为 `task_agent`），让主 LLM 可以派出**进程内**的 sub-AgentSession 完成需要 LLM 判断力的子任务（探查、综合、调研、并行 fan-out）。本期是子项目 C，建立在子项目 A（Task 框架）和子项目 B（LocalShellTask）之上。

不开子进程、不走 RPC。直接调 Pi SDK 的 `createAgentSessionFromServices()` 在主进程内起独立 LLM 会话，与主 agent 共进程、共 ModelRegistry、共 prompt cache。Spike 已实测验证（详见 §11）。

支持 `subagent_type` 参数选 agent 定义起 clean sub；省略 `subagent_type` 走 fork 路径，sub 继承主 session 完整对话历史。

## 关键设计原则

**对齐 claudecode**。除以下 SDK / Pi extension 边界冲突外，行为与 claude 原版 AgentTool 完全一致：

| 必须偏离原版的点 | 原因 |
|---|---|
| 同步模式下 sub 进度不暴露给主 LLM | Pi `ToolDefinition.execute` 签名是 `Promise<AgentToolResult>`，不是 async generator，没法 yield 中间帧 |
| 防递归仅靠 `<fork_boilerplate>` tag 检测 + 工具池硬剔除，不做 cache parity 调优 | claude 原版保留 `task_agent` in fork-child tools 是为了 prompt cache 命中；Pi 这边没那么多 fork 调用，简单为先 |
| agent 定义来源用 `~/.pi/agents/` 而非 `~/.claude/agents/` | 这是 Pi 仓库不是 Claude 仓库 |
| 不实现 `worktree` / `remote` isolation、`team_name` / `mode` / `name`、coordinator mode、skills 预加载、memory、hooks | 这些是 D/E 期或本仓库不实现的范围 |

## 目标

- 主 LLM 用 `task_agent` 派出 sub-AgentSession 跑独立 LLM turn，sub 拿独立工具池干活后返回结果
- 三态执行（claude 同款）：同步默认 / 超时自动后台 / 显式后台
- 后台路径无缝接入子项目 A 的 `notifyTaskTerminal` / `markTaskNotified` / `triggerTurn:true` 唤醒主 LLM
- 支持 `subagent_type` 选 agent 定义（内置 + 用户级 + 项目级 markdown）
- Fork 路径：sub 继承主 session 完整历史，自动补占位 tool_result，注入 boilerplate child message
- 接入子项目 A 的 task 框架：复用 `task_kill` / `task_status` / `task_list` / `notifyTaskTerminal` / disk output

## 不在范围

- ❌ `worktree` / `remote` isolation（参数保留但报"未支持"）
- ❌ `name` / `team_name` / `mode`（multi-agent 参数，D 期）
- ❌ coordinator mode、in-process teammate 长期对话（D 期）
- ❌ resume agent / fork-from-leaf-id 高级路径
- ❌ 复杂 frontmatter：`criticalSystemReminder_EXPERIMENTAL` / `memory` / `hooks` / `mcpServers` / `requiredMcpServers` / `skills` / `effort` / `permissionMode` / `pendingSnapshotUpdate` / `omitClaudeMd`
- ❌ 同步模式 sub 进度上推主 LLM（`onUpdate` 推送）
- ❌ MCP server 注入到 sub-session

## 1. 架构

### 1.1 模块划分（`extensions/localagent/`）

```
extensions/localagent/
├── package.json                       # 同 B 期 pi-localshell-extension 风格
├── index.ts                           # extension entrypoint
├── localAgentTask.ts                  # Task impl: spawn / kill / state shape
├── localAgentTask.test.ts
├── spawnLocalAgent.ts                 # 起 sub-session 的核心逻辑（sync/async/fork 三路汇合）
├── spawnLocalAgent.test.ts
├── agentDefinitions/                  # agent 定义加载
│   ├── builtIn.ts                     # GENERAL_PURPOSE / EXPLORE 内置
│   ├── builtIn.test.ts
│   ├── loadFromDisk.ts                # 用户级 + 项目级 markdown 加载
│   ├── loadFromDisk.test.ts
│   ├── frontmatter.ts                 # YAML frontmatter 解析（仅 C 期支持的字段子集）
│   ├── frontmatter.test.ts
│   ├── resolve.ts                     # 合并优先级 + 按 agentType 查找
│   ├── resolve.test.ts
│   └── types.ts                       # AgentDefinition 类型
├── fork/
│   ├── buildForkedMessages.ts         # 给 forked SM 补占位 tool_result + 拼 boilerplate
│   ├── buildForkedMessages.test.ts
│   ├── boilerplate.ts                 # FORK_BOILERPLATE_TAG 常量 + child message 模板
│   └── recursionGuard.ts              # 检测 ctx.messages 里是否含 boilerplate tag
├── outputTranslator.ts                # subscribe 事件 → outputFile 行
├── outputTranslator.test.ts
├── tools/
│   ├── taskAgent.ts                   # task_agent tool 定义
│   └── taskAgent.test.ts
└── progress.ts                        # tool/token 计数（sub 用,主 LLM 后台路径展示）
```

### 1.2 加载顺序

字典序：`localagent` 在 `localshell` 之后、`tasks` 之前。所以本扩展加载时，B 期 `localshell` 已经注册了 `local_bash` task type，A 期 `tasks` 还没起 session_start hook。和 B 期同样依赖：通过 `getTasksHandle(pi)` 拿 store + registerTaskType，**不**直接 import `tasks/*.ts`，避免 module-realm 隔离问题。

### 1.3 sub-AgentSession 生命周期

```
spawnLocalAgent(pi, store, params)
  ├─ resolve agentDefinition (subagent_type → builtIn/disk;省略 → FORK_AGENT)
  ├─ 防递归检查 (boilerplate tag in ctx.messages → throw)
  ├─ services = await createAgentSessionServices({cwd: params.cwd})
  ├─ if (fork)
  │     parentFile = ctx.sessionManager.getSessionFile()  必填,否则报错
  │     sm = SessionManager.forkFrom(parentFile, params.cwd)
  │     buildForkedMessages(sm)  补占位 tool_result
  │     promptText = boilerplate + directive
  │   else
  │     sm = SessionManager.inMemory(params.cwd)
  │     promptText = params.prompt
  ├─ {session} = await createAgentSessionFromServices({
  │     services, sessionManager: sm, model, tools: agentDef.tools(剔除 task_agent)
  │   })
  ├─ unsub = session.subscribe(event => translateAndAppend(taskId, event))
  ├─ registerTask(state, store)
  ├─ 三路 race:
  │     ── 同步:
  │           await session.prompt(promptText)
  │           await waitForAgentEnd(session)
  │           dispose, return synced result
  │     ── 自动后台 (timeout 触发):
  │           registerTask + return Backgrounded(taskId)
  │           后台 await agent_end → 写终态 → notifyTaskTerminal
  │     ── 显式后台 (run_in_background=true / fork / agent.background=true):
  │           直接走自动后台分支,timeout=0
  └─ kill 路径:LocalAgentTask.kill(taskId, store) → session.abort() → dispose → updateTaskState 'killed' → notifyTaskTerminal
```

## 2. LLM tool 设计

### 2.1 `task_agent`

**参数 schema**（typebox）：

```ts
const TaskAgentParams = Type.Object({
  description: Type.String({ description: "Short (3-5 word) description of the task." }),
  prompt: Type.String({ description: "The task for the agent to perform." }),
  subagent_type: Type.Optional(Type.String({ description: "Type of specialized agent. Omit to fork (inherits parent context)." })),
  model: Type.Optional(Type.Union([Type.Literal("sonnet"), Type.Literal("opus"), Type.Literal("haiku")])),
  run_in_background: Type.Optional(Type.Boolean({ description: "Run as background task; main agent gets a notification on completion." })),
  cwd: Type.Optional(Type.String({ description: "Override working directory for the sub-agent." })),
  isolation: Type.Optional(Type.Literal("worktree")),
});
```

`isolation` 字段描述写在 schema description 里(typebox 单字面量描述需放 Optional 包装层,因 plan 阶段会精确确认 typebox API,此处不展开):告知 LLM "Reserved; not implemented in C phase."。`isolation: "worktree"` 进 execute 立即报错 `"isolation 'worktree' not yet supported in this phase"`。

### 2.2 三态执行

| 输入 | 行为 |
|---|---|
| 默认（无 background flag、无 fork、agentDef.background ≠ true）| 同步：execute 内 await sub agent_end → 返完整 final |
| 同步 + 跑了 `AUTO_BACKGROUND_MS`（默认 120_000）还没完 | 同步分支自动转后台：返 Backgrounded(taskId)，sub 继续后台跑 |
| `run_in_background:true` | 立即后台，不等 |
| `subagent_type` 省略（→ fork 路径）| 强制后台（claude 同款；reason: 解决主 session 当前 turn 与 sub turn 同时进行时的 cache/抢锁问题） |
| `agentDef.background:true` | 立即后台 |
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` 等价 env `PI_DISABLE_BACKGROUND_TASKS=1` | 全关，所有路径强制同步 |

### 2.3 返回格式

**同步成功**：

```
content[0].text = `${finalAssistantText}`
details = {
  action: "task_agent",
  status: "completed",
  taskId,
  agentType,
  model,
  toolCallCount,
  tokenCount,
  durationMs,
}
```

**后台启动**：

```
content[0].text = `Backgrounded (taskId=${taskId}, agentType=${agentType}). Use task_status to query, task_kill to abort.`
details = { action: "task_agent", status: "running", taskId, agentType, model, isBackgrounded: true }
```

**fork 路径**（永远后台）：同上 Backgrounded 但 `agentType: "fork"`。

**isolation 不支持**：

```
content[0].text = "isolation 'worktree' not yet supported in this phase"
isError: true
```

## 3. AgentDefinition 加载

### 3.1 类型

```ts
export interface AgentDefinition {
  agentType: string;            // 唯一名,进入 task_agent.subagent_type 选择空间
  whenToUse: string;            // 写在 task_agent description 里给主 LLM 看
  tools?: string[];             // 不写则默认 [read, grep, find, ls]
  disallowedTools?: string[];   // 显式黑名单(优先于 tools)
  model?: "sonnet" | "opus" | "haiku" | "inherit";
  background?: boolean;         // 强制后台
  maxTurns?: number;
  description?: string;         // 一句简介
  source: "built-in" | "user" | "project";
  filename?: string;            // 调试用
  systemPrompt: string;         // claude 是函数;Pi 这边静态字符串够
}
```

注意 C 期 `systemPrompt` 是**静态字符串**，不是函数。claude 原版的 `getSystemPrompt({toolUseContext})` 让内置 agent 能根据上下文动态拼 prompt（例如 statusline-setup-agent 读 settings 当前状态）—— Pi 这边不需要这种动态性，本期直接用闭包拿到的字符串。

### 3.2 加载顺序

1. 内置 `getBuiltInAgents()` → `[GENERAL_PURPOSE_AGENT, EXPLORE_AGENT]`
2. 用户级 `~/.pi/agents/*.md` → 读 frontmatter，body 当 systemPrompt
3. 项目级 `<cwd>/.pi/agents/*.md`（先 walk up 找最近的有 `.pi/agents/` 的目录）

按 `agentType` 合并，**项目级覆盖用户级覆盖内置**。

### 3.3 frontmatter 子集（C 期支持）

```yaml
---
agentType: explorer
whenToUse: "Use for exploring large unfamiliar codebases."
tools: [read, grep, find, ls]
disallowedTools: [bash]
model: opus
background: false
maxTurns: 50
description: "An eager codebase explorer."
---
```

未列字段直接忽略不报错（避免 frontmatter 兼容性问题）。

### 3.4 内置 agent 定义

**GENERAL_PURPOSE_AGENT**：

```ts
{
  agentType: "general-purpose",
  whenToUse: "General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks.",
  tools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
  source: "built-in",
  systemPrompt:
    "You are a general-purpose research and execution agent dispatched by a parent agent. " +
    "Stay strictly within the assigned task. Use your tools directly; do not converse, " +
    "ask questions, or speculate beyond the task. When done, return a concise factual report.",
}
```

**EXPLORE_AGENT**：

```ts
{
  agentType: "explore",
  whenToUse: "Read-only codebase exploration. Returns excerpts, doesn't modify files.",
  tools: ["read", "grep", "find", "ls"],
  source: "built-in",
  systemPrompt:
    "You are a read-only codebase explorer. You have file-read and search tools only. " +
    "Locate relevant code, return file paths and short excerpts; do not summarize or " +
    "editorialize. Output format: { files: [{path, lineRange, excerpt}], notes: string[] }.",
}
```

### 3.5 FORK_AGENT（合成 agent，不可被 subagent_type 选）

```ts
{
  agentType: "__fork__",        // 内部名,主 LLM 不可见
  whenToUse: "Implicit fork — inherits full conversation context.",
  tools: ["*"],                 // 全开,但 task_agent 永远剔除
  background: true,             // 强制后台
  source: "built-in",
  systemPrompt: "",             // fork 不重设 system prompt,继承父
}
```

`subagent_type` 省略时使用此合成定义。

## 4. Sub-session tool 池

### 4.1 工具池构造规则

```ts
function resolveSubAgentTools(
  agentDef: AgentDefinition,
  allRegisteredTools: string[],
): string[] {
  let tools: string[];
  if (agentDef.tools?.includes("*")) {
    tools = [...allRegisteredTools];
  } else if (agentDef.tools) {
    tools = [...agentDef.tools];
  } else {
    tools = ["read", "grep", "find", "ls"];  // 安全默认
  }
  if (agentDef.disallowedTools) {
    tools = tools.filter(t => !agentDef.disallowedTools!.includes(t));
  }
  // 永远剔除 task_agent —— 防递归最强保护
  tools = tools.filter(t => t !== "task_agent");
  return tools;
}
```

由 `createAgentSessionFromServices({tools: resolved})` 注入。

### 4.2 防递归

**Layer 1**（硬保护）：sub 工具池永远不含 `task_agent`，sub 物理上无法再发起 fork/spawn。

**Layer 2**（兜底，对齐 claude）：`spawnLocalAgent` 入口检查 `ctx.messages` 是否含 `<fork_boilerplate>` tag。如果含 → throw `"Fork is not available inside a forked worker. Complete your task directly using your tools."`

虽然 Layer 1 已经够强，但保留 Layer 2 作为 defense-in-depth：万一未来有人不小心把 task_agent 加回 sub 工具池，仍能拒绝。

## 5. Fork 路径

### 5.1 触发条件

`subagent_type === undefined`（schema 上是 optional）。

### 5.2 步骤

1. **取主 session 文件**：`parentFile = ctx.sessionManager.getSessionFile()`。如果 undefined（用户跑了 `--no-session`）→ throw `"Fork requires a persisted parent session. Run pi without --no-session."`
2. **fork 物理拷贝**：`sm = SessionManager.forkFrom(parentFile, params.cwd ?? ctx.cwd)`
3. **补占位 tool_result**（`buildForkedMessages.ts` 实现）：
   - 读 `sm.getEntries()` 末尾 entry
   - 如果末尾是 assistant message 含未完成 tool_use blocks（即没有对应的 tool_result entries 在它之后）：
     - 对每个未完成 tool_use，append 一个 ToolResultMessage entry，content 全部用同一字符串 `FORK_PLACEHOLDER_RESULT = "Subagent forked — running in background"`
   - 用 SessionManager 的写接口（具体哪个 API plan 阶段精确确认；候选 `appendEntry` / `add` / 直接写 jsonl 后 reload）
4. **拼 child message**：

```ts
const directive = `<${FORK_BOILERPLATE_TAG}>
STOP. READ THIS FIRST.

You are a forked worker process. You are NOT the main agent.

RULES:
1. Do NOT spawn sub-agents.
2. Use your tools directly.
3. Stay strictly within your assigned scope.
4. Keep your final report under 500 words unless asked otherwise.
5. Begin your final response with "Scope:".
</${FORK_BOILERPLATE_TAG}>

${params.prompt}`;
```

5. **起 sub-session**：`createAgentSessionFromServices({sessionManager: sm, ...})` + `session.prompt(directive)`

`FORK_BOILERPLATE_TAG = "fork_boilerplate"`，`FORK_PLACEHOLDER_RESULT` 字符串 const 不变 → 所有 fork child 共享同一前缀字节，prompt cache 友好。

### 5.3 plan 阶段必须解决的开放问题

**SDK 的 SessionManager append-entry 接口形状未确认**。当前 `session-manager.d.ts` 公开的写接口包括 `branch`/`branchWithSummary`/`createBranchedSession`,但是否暴露"append 一个 ToolResultMessage entry 到末尾"的 API 还未读完。plan 第 1 个 Task 必须先做 30 分钟 spike,验证以下三种实现方案哪个可行:

- **方案 A**(首选):SessionManager 公开了 `appendEntry(entry)` 或类似 — 直接调
- **方案 B**:不暴露公开 API,但能 `fs.appendFileSync(sm.getSessionFile(), JSON.stringify(toolResultEntry) + "\n")` 后通过 `SessionManager.open(file)` 重新加载 — 安全但低效(整 jsonl 重读)
- **方案 C**:绕开磁盘,直接构造 inMemory SM 然后手动注入 entries — 最干净,但要求能从主 session 拿到 entries 数组复制过来

plan Task 1 的产出是"已确定 buildForkedMessages.ts 内具体调用什么 SDK 接口",后续 Task 才进 buildForkedMessages 实现。如果三案都不可行,fork 路径降级:不补占位、只在 prompt 前面加文字提示("以下未完成的 tool 调用请忽略,直接执行新 directive...") + 标记 spec 为 "fork 路径降级实现"。

## 6. 输出转译

`outputTranslator.ts` 监听 sub-session.subscribe 事件，**只**写两类：

| 事件 | 输出行 |
|---|---|
| `tool_execution_start` | `[tool] {toolName}({argsPreview ≤80 chars})\n` |
| `tool_execution_end`（success） | `[ok] {toolName} → {resultPreview ≤80 chars}\n` |
| `tool_execution_end`（isError） | `[err] {toolName}: {error ≤200 chars}\n` |
| `message_end` 且 `role==="assistant"` 且是 `agent_end` 那一帧前的最后一条 | `\n=== FINAL ===\n{fullText}\n` |
| `agent_end` | `\n=== END (turns={turnCount}, tools={toolCount}) ===\n` |

中间 `message_update` / thinking 不写，避免 outputFile 爆炸。

格式化后调用 B 期 `appendTaskOutput(taskId, line)`。

## 7. Progress 计数

`progress.ts` 维护一个 in-memory `Map<taskId, AgentProgress>`：

```ts
interface AgentProgress {
  toolCallCount: number;
  tokenCount: number;       // 累加每条 message_end[assistant].usage.totalTokens
  startTime: number;
  recentToolNames: string[]; // 滑动窗口 5 个
}
```

后台路径 `notifyTaskTerminal` 时把 progress 写进 details，让主 LLM 在通知里看到 sub 跑了多少工具、用了多少 token。

**plan 阶段确认点**:`message_end.message.usage.totalTokens` 究竟是 per-message 增量还是 cumulative。如果是 cumulative,改成"取最新值"而非"累加";plan Task 2(progress 实现)第一步用真 Pi SDK 跑一个有多 turn 的 session 实测。

## 8. Kill

`LocalAgentTask.kill(taskId, store)` 实现：

```ts
async kill(taskId, store) {
  const task = store.getTask(taskId);
  if (!task || isTerminalTaskStatus(task.status)) return;
  const localAgentTask = task as LocalAgentTaskState;
  updateTaskState(taskId, store, t => ({...t, status: "killed", endTime: Date.now()}));
  try {
    await localAgentTask.session?.abort();    // SDK abort 是 async,等它 settle
  } catch {/* ignore */}
  localAgentTask.cleanup?.();                 // 先 unsub event listener,再 dispose
  localAgentTask.session?.dispose();
  await notifyTaskTerminal(_getPi(), store, taskId, {triggerTurn: true});
  await evictTaskOutput(taskId);
}
```

注意 `session` 引用从 `LocalAgentTaskState` 拿（C 期把 session 对象塞进 state，类似 B 期 LocalShellTaskState 的 abortController）。

**顺序敏感**:
1. `updateTaskState 'killed'` 先于 abort —— 即使 abort 触发的 message_end 还在 pipe,outputTranslator 看到 task 已 killed 也不会再 append
2. `cleanup()` (unsub) 必须在 `dispose()` 之前 —— SDK dispose 内部清 listeners,如果 unsub 不抢先调用,unsub 函数会变成 no-op,无害但浪费
3. `notifyTaskTerminal` 在 dispose 之后 —— notify 只读 store,不需要 session 还活着

plan 阶段的 spike 第 2 步会跑一次 abort+dispose race condition 验证。

## 9. State 形状

```ts
export interface LocalAgentTaskState extends TaskStateBase {
  type: "local_agent";
  prompt: string;                    // 原始 prompt（fork 时是 directive 部分,不含 boilerplate）
  agentType: string;                 // "general-purpose" / "explore" / "__fork__" / 用户自定义
  model?: string;
  isBackgrounded: boolean;           // 是否已转后台
  isFork: boolean;                   // 是否 fork 路径
  forkParentSessionFile?: string;    // fork 时填,调试用
  // SDK 句柄(运行期)
  session?: import("@earendil-works/pi-coding-agent").AgentSession;
  cleanup?: () => void;              // unsub 函数
  // 进度
  progress?: AgentProgress;
  // 终态
  result?: { finalText: string; toolCallCount: number; tokenCount: number };
  error?: string;
}
```

## 10. extension entrypoint

```ts
let _pi: ExtensionAPI | undefined;
export function _bindPi(pi: ExtensionAPI): void { _pi = pi; }
export function _unbindPi(): void { _pi = undefined; }
export function _getPi(): ExtensionAPI {
  if (!_pi) throw new Error("[localagent] pi not bound; called outside session lifecycle");
  return _pi;
}

export default function localagentExtension(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const handle = getTasksHandle(pi);
    _bindPi(pi);
    handle.registerTaskType("local_agent", LocalAgentTask);
    pi.registerTool(buildTaskAgentTool(handle.store));
  });

  pi.on("session_shutdown", async () => {
    const handle = getTasksHandle(pi);
    const running = getRunningTasks(handle.store.get()).filter(t => t.type === "local_agent");
    await Promise.all(running.map(t => LocalAgentTask.kill(t.id, handle.store)));
    handle.unregisterTaskType("local_agent");
    _unbindPi();
  });
}
```

`buildTaskAgentTool` 接 store 不接 ctx —— `ctx` 是 execute 调用时第 5 个参数,真正起 sub 的时候才用。`spawnLocalAgent` 内部需要 pi 句柄(notifyTaskTerminal 调用)时,通过 `_getPi()` 拿 module-level 闭包里的 pi。这跟 B 期 LocalShellTask 的 `_bindPi/_unbindPi` 完全对齐。

不需要 shadow 任何 Pi 内置工具(C 期 `task_agent` 跟 Pi 内置工具不冲突)。

## 11. SDK 假设验证（已完成）

子项目 C 启动前已跑两个 spike，证明 SDK 假设全部成立：

### Spike 1 — `extensions/spike-localagent`

`createAgentSessionServices({cwd}) + SessionManager.inMemory() + createAgentSessionFromServices({services, sessionManager, model, tools: ["read","grep","find","ls"]})` → `session.prompt("用一句中文说你好")`

**结果**：sub-session 成功创建（id=019e87c3-46f9-722a-aa6b-810c0a6b7d69），跑完一个 turn，`agent_end` 事件触发，最终 assistant 文本 "你好,很高兴见到你!" 正常拿到。`session.dispose()` 干净退出，无 timer/handle 泄漏。事件序列 `agent_start:1, turn_start:1, message_start:2, message_end:2, message_update:6, turn_end:1, agent_end:1`。

### Spike 2 — `extensions/spike-fork`

`SessionManager.forkFrom(ctx.sessionManager.getSessionFile(), cwd) + createAgentSessionFromServices(...)` → 验证 prefix 历史是否继承

**结果**：forkFrom 成功创建带前缀的新 SM，prefixMessages=2（fork 前继承的消息数）→ finalMessages=4（prompt+response 后）。**但**：sub 误以为自己是主 agent，原因是父 session 末尾 assistant message 含正在执行的 tool_use（`spike_fork_subagent` 本身）但没对应 tool_result。这正是本 spec §5 要解决的核心问题，也是为什么必须手写 `buildForkedMessages` 补占位。

### 结论

进程内 sub-AgentSession 路线技术可行；fork 物理层可行；fork 语义层需要本期手写补占位逻辑。Pi 文档说"不支持 in-process child LLM sessions"是对 ExtensionAPI 而言；通过直接 import 主包 `@earendil-works/pi-coding-agent` re-export 的 `createAgentSession*` 系列 SDK API 是合法的灰名单路径（文档允许 import 主包，类型签名不阻止）。

Spike extension 在 spec 通过后即删除（不进 main 分支）。

## 12. 错误处理

| 错误 | 行为 |
|---|---|
| `subagent_type` 不存在 | execute 立即返 `isError: true`，列出可用 agentType 让 LLM 选一个 |
| Fork 时主 session 没文件（`--no-session`） | execute 立即返 `isError: true`，提示用户去掉 `--no-session` |
| `isolation: "worktree"` | execute 立即返 `isError: true`，"not yet supported" |
| sub-session.prompt() throws | updateTaskState 'failed'，写 error 到 outputFile，notifyTaskTerminal |
| sub-session 跑到一半被主 session abort | LocalAgentTask.kill 走完整路径 |
| ModelRegistry 无 API key | services 创建时抛 → execute 返 isError，引导 `pi /login` |

## 13. 测试规模与验收

| 模块 | 测试数 |
|---|---:|
| AgentDefinition 加载 / frontmatter / 优先级合并 | 12 |
| 工具池解析（含 `*` 展开 / disallowed / task_agent 剔除） | 8 |
| spawnLocalAgent 三态执行 | 12 |
| Fork 路径（buildForkedMessages 占位 + boilerplate 拼接） | 10 |
| 输出转译 | 8 |
| Progress 计数 | 4 |
| Kill 路径 | 5 |
| 防递归（boilerplate tag 检测 + 工具池硬剔除） | 4 |
| task_agent tool execute（含 isolation / 错误分支） | 12 |
| **小计 C 期新增** | **75** |
| 现有 (A+B 合计) | 391 |
| **总计** | **466** |

代码量预估：~1100 行 prod + ~1500 行测试。

## 14. 与 D 期边界

C 期完成后，`local_agent` task 是**单次派发完即结束**的语义：spawn → run → terminal → evict（可选 grace 30s）。

D 期 InProcessTeammate 是新 task type `in_process_teammate`，新 LLM tool（`spawn_teammate` / `send_message_to_teammate` / `close_teammate`），新 state shape（不 dispose、保留 session、可反复 prompt、leadership/follower 关系）。**不复用** C 期的代码，重新起底。这跟 claude 原版 LocalAgentTask 与 InProcessTeammateTask 是两个独立 task type 的设计一致。

C 期不预留 D 期接口，保持 `local_agent` 语义最简。

## 15. 配套清理

C 期合入 main 时同步删除 `extensions/spike-localagent/` 和 `extensions/spike-fork/`（spike 已完成历史使命，留着会污染 extension 自动加载）。
