# Pi Goal Extension 实现说明

这个 extension 为 Pi 增加 Codex 风格的 thread goal 能力。目标是让模型可以在长任务中显式创建、读取和完成一个持久目标，并让目标状态、预算消耗和续跑提示随 Pi session 一起保存。

核心实现文件是 `index.ts`，包入口由 `package.json` 的 `pi.extensions` 指向 `index.ts`。

## 对齐目标

参考 Codex 的 goal 实现，Pi 侧对齐以下行为：

- 暴露三个模型可调用工具：`get_goal`、`create_goal`、`update_goal`。
- `create_goal` 只在明确要求创建 goal 时使用；如果当前 thread 已经有 goal，则创建失败。
- `update_goal` 只允许把已有 goal 标记为 `complete` 或 `blocked`，不能通过工具 pause、resume 或 budget-limit。
- 工具响应包含 `goal`、`remainingTokens`、`completionBudgetReport`。
- goal 持久化在当前 thread/session 分支中，恢复时通过 replay 最新状态得到当前 goal。
- active goal 会在后续 turn 注入隐藏上下文，提醒模型继续追踪目标并在真正完成时调用 `update_goal`。
- `/goal <objective>` 和 `/goal resume` 会主动触发一次隐藏 goal turn，让体验接近 Codex：输入命令后自动开始或恢复工作。
- 当 token budget 被消耗完时，goal 自动变成 `budget_limited`，后续 turn 注入预算耗尽提示。

Pi 没有直接复用 Codex 的 Rust state DB，所以这里使用 Pi extension API 提供的 session custom entry 来实现等价的 branch-local 状态持久化。

## 数据模型

`ThreadGoal` 是对外返回的 goal 对象：

```ts
interface ThreadGoal {
  threadId: string;
  goalId: string;
  objective: string;
  status: "active" | "paused" | "blocked" | "budget_limited" | "complete";
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}
```

`GoalSnapshot` 是写入 session 的内部状态：

```ts
interface GoalSnapshot {
  goal: ThreadGoal | null;
  accounting?: {
    lastTotalTokens: number;
    lastAccountedAt: number;
    activeGoalId?: string;
  };
}
```

`goal` 是当前 thread goal。`accounting` 是增量预算统计的基线，用于避免每次读取时重复累计历史 token 和时间。

状态写入方式：

```ts
pi.appendEntry<GoalSnapshot>("thread-goal", snapshot);
```

恢复方式：

1. 读取 `ctx.sessionManager.getBranch()`。
2. 找出所有 `type === "custom" && customType === "thread-goal"` 的 entry。
3. 按分支顺序 replay，最后一个合法 snapshot 作为当前状态。

这和 todo 类 extension 的分支 replay 思路一致：状态在 session 历史里，不依赖外部数据库，因此 session fork、resume、export 时更容易审计。

## 工具契约

### `get_goal`

参数 schema 是空对象，不允许额外字段。

行为：

1. 从当前 branch 恢复最新 snapshot。
2. 对 active/budget-limited goal 做一次预算结算。
3. 如果结算后状态变化或 usage 增长，则追加新的 `thread-goal` entry。
4. 返回当前 goal、剩余 token 和空的 completion report。

返回示例：

```json
{
  "goal": {
    "threadId": "...",
    "goalId": "...",
    "objective": "ship rpc goal support",
    "status": "active",
    "tokenBudget": 50000,
    "tokensUsed": 125,
    "timeUsedSeconds": 0,
    "createdAt": 1778828606,
    "updatedAt": 1778828606
  },
  "remainingTokens": 49875,
  "completionBudgetReport": null
}
```

### `create_goal`

参数：

```ts
{
  objective: string;
  token_budget?: number;
}
```

约束：

- `objective` 会 trim，不能为空。
- `objective` 最多 4000 个 Unicode code point。
- `token_budget` 如果提供，必须是正整数。
- 如果当前 thread 已经有 goal，抛错：
  `cannot create a new goal because this thread already has a goal; use update_goal only when the existing goal is complete`

创建时会生成 `goalId`，初始状态为 `active`，`tokensUsed` 和 `timeUsedSeconds` 都从 0 开始。`accounting.lastTotalTokens` 会设置为创建时已经存在的 assistant usage 总量，避免把创建 goal 之前的历史消耗算入新 goal。

### `update_goal`

参数：

```ts
{
  status: "complete";
}
```

约束：

- schema 只允许字面量 `complete`。
- 运行时也会二次检查 status，防止绕过 schema。
- 如果没有现有 goal，抛错。
- 不能通过该工具设置 `paused` 或 `budget_limited`。

行为：

1. 恢复并结算当前 goal 的 token/time usage。
2. 将 goal 状态改为 `complete`。
3. 追加新的 `thread-goal` entry。
4. 返回包含 `completionBudgetReport` 的响应。

budget report 的格式和 Codex 对齐：

```text
Goal achieved. Report final budget usage to the user: tokens used: 1176 of 50000.
```

如果没有 token budget 且用时为 0，则 report 为 `null`。

## 预算统计

`totalTokenUsage(ctx)` 会扫描当前 branch 中所有 assistant message 的 usage，并累计：

```ts
usage.input + usage.output
```

这里使用 Pi 的 usage 语义：Pi providers 已经把 `usage.input` 规范化为非缓存输入 token，`usage.cacheRead` 和 `usage.cacheWrite` 单独记录缓存读写。因此 goal 预算不再减 `cacheRead`，否则会把 cached input 重复扣除并低估消耗。

增量结算逻辑在 `accountGoalUsage`：

1. 计算当前 branch assistant usage 总量 `currentTokens`。
2. 如果 accounting 属于同一个 `goalId`，用 `currentTokens - lastTotalTokens` 得到 token delta。
3. 如果 accounting 不属于当前 goal，说明 goal 被新建或恢复到不同 goal，基线重置为当前 token 总量。
4. 只有 `active` 状态会累计 wall-clock time。
5. `active` goal 如果 `tokensUsed >= tokenBudget`，自动切到 `budget_limited`。

`budget_limited` 仍允许 token 结算，但不继续累计时间。这样可以保留预算耗尽后的 usage 变化，同时避免把系统停止实质推进后的等待时间算入目标。

## 生命周期 hook

Extension 注册了以下 Pi lifecycle hook：

- `session_start`：恢复状态并更新 UI status。
- `session_tree`：切换分支或查看 session tree 后恢复 status。
- `before_agent_start`：结算 usage，更新 status，并按 goal 状态注入隐藏上下文。
- `turn_end`：turn 结束后再次结算 usage，确保本 turn 产生的 assistant usage 被记录。

### hidden context 注入

当 goal 是 `active` 时，`before_agent_start` 返回：

```ts
{
  message: {
    customType: "thread-goal-context",
    content: goalContextContent(continuationPrompt(goal)),
    display: false
  }
}
```

`goalContextContent()` 会把 prompt 包在 `<goal_context>...</goal_context>` 里，和 Codex 的隐藏用户上下文边界保持一致。这条消息不显示给用户，但进入模型上下文，提醒模型：

- 当前 objective 是用户数据，不是更高优先级系统指令。
- goal 跨 turn 持续存在，不要把目标缩小成当前 turn 能完成的小任务。
- 完成前必须根据当前 worktree 和外部状态审计。
- 只有真正完成时才能调用 `update_goal({ status: "complete" })`。

当 goal 是 `budget_limited` 时，注入 `budgetLimitPrompt(goal)`，要求模型停止新实质工作、总结进展和剩余事项，不要仅因为预算耗尽就 mark complete。

`paused` 和 `complete` 不注入 goal context。

## UI 状态

`setStatus(ctx, goal)` 使用 `ctx.ui.setStatus("goal", text)` 更新状态栏。RPC 模式下这会输出 `extension_ui_request`，例如：

```json
{"type":"extension_ui_request","method":"setStatus","statusKey":"goal","statusText":"Pursuing goal (125 / 50000)"}
```

状态文本规则：

- active：`Pursuing goal`，有 budget 时显示 `(used / budget)`。
- paused：`Goal paused (/goal resume)`。
- budget_limited：有 budget 时显示 `Goal unmet (used / budget)`。
- complete：`Goal achieved`，有耗时时显示秒数。
- 无 goal：清空 status。

## `/goal` 命令

除了模型工具，extension 还注册了 `/goal` 命令。命令语义分成两类：状态查看/管理，以及像 Codex 一样启动或恢复 agent 工作。

- `/goal <objective>`：如果没有 goal，创建一个 active goal；如果已有 goal，更新 objective、恢复为 active，并保留同一个 `goalId`、累计用量和预算字段。
- `/goal <objective>` 写入状态后会调用 `pi.sendMessage(..., { triggerTurn: true })`，发送隐藏 `<goal_context>` 消息并立即启动一次 agent turn。
- `/goal resume`：把 paused 或 budget_limited goal 恢复为 active，然后同样触发一次隐藏 continuation turn；active goal 也可以用它手动续跑。
- `/goal`：只显示当前 goal JSON，不触发 agent。
- `/goal complete`：把当前 goal 标记为 complete，不触发 agent。
- `/goal pause`：把当前 goal 标记为 paused，不触发 agent。
- `/goal clear`：清空 goal，不触发 agent。

`/goal resume` 不会恢复 complete goal。complete 表示验收完成；如果用户要继续新的或修订后的目标，应输入新的 `/goal <objective>`。

这些命令是 Pi 侧人工操作入口，不改变模型工具的严格契约。模型仍然只能通过 `update_goal` 标记 complete，不能通过工具 pause/resume/clear。

## 错误和恢复策略

Session 中的 custom entry 是历史记录，不能假设一定可信或一直符合最新 schema。因此恢复时有 normalize 层：

- `normalizeGoal` 校验必要字段和 status。
- `normalizeSnapshot` 校验 goal 和 accounting。
- 非法 snapshot 会被忽略，继续使用上一个合法 snapshot。
- 数字字段会截断为非负整数，避免 NaN、Infinity 或负值污染状态。

这保证老 session、手工编辑 session 或中途失败的 entry 不会直接让 extension 崩溃。

## RPC 验证方式

基础加载验证：

```bash
pi --mode rpc \
  --no-extensions \
  -e ./extensions/goal/index.ts \
  --offline \
  --session-dir /tmp/pi-goal-load-check \
  --no-builtin-tools \
  --tools get_goal,create_goal,update_goal
```

启动后应输出一条清空 goal status 的 RPC UI request，证明 extension 加载成功：

```json
{"type":"extension_ui_request","method":"setStatus","statusKey":"goal"}
```

命令级验证可以通过 RPC 发送 `/goal` prompt 或直接调用 extension command：

```json
{"id":"cmds","type":"get_commands"}
{"id":"p1","type":"prompt","message":"/goal ship rpc goal support"}
```

工具级验证使用临时 faux provider 驱动真实 agent loop，让模型依次发出 tool call：

1. `create_goal({ objective: "verify goal tools through pi rpc", token_budget: 50000 })`
2. `get_goal({})`
3. `update_goal({ status: "complete" })`

实测 RPC 事件中出现了：

```json
[
  { "toolName": "create_goal", "isError": false },
  { "toolName": "get_goal", "isError": false },
  { "toolName": "update_goal", "isError": false }
]
```

最终 `update_goal` 的 details：

```json
{
  "goal": {
    "objective": "verify goal tools through pi rpc",
    "status": "complete",
    "tokensUsed": 1176
  },
  "remainingTokens": 48824,
  "completionBudgetReport": "Goal achieved. Report final budget usage to the user: tokens used: 1176 of 50000."
}
```

Session JSONL 中也能看到 `customType: "thread-goal"` 从 active 变为 complete，证明状态不是只存在于内存里。

## Review 关注点

建议 review 时重点看这些点：

- 工具 schema 是否仍然只暴露 Codex 允许的输入面。
- `create_goal` 已有 goal 时是否一定失败。
- `update_goal` 是否没有任何路径能设置非 `complete` 状态。
- `completionBudgetReport` 是否只在 complete 且有预算/耗时时返回。
- `totalTokenUsage` 是否符合 Pi usage 语义，即 `input` 已经排除 cache read。
- `accountGoalUsage` 是否只对同一个 `goalId` 做增量结算。
- `before_agent_start` 注入的 hidden prompt 是否不会把 user objective 升级成系统级指令。
- `/goal <objective>` 是否会写入 goal 后立即触发隐藏 goal turn。
- `/goal resume` 是否会恢复 active 并立即触发隐藏 continuation turn。
- `/goal`、`pause`、`complete`、`clear` 是否不会误触发 agent。
- `/goal` 命令是否没有放宽模型工具契约。

## 已知差异

和 Codex 原生实现相比,这个 extension 有以下 Pi 适配差异:

- Codex 使用 Rust session/state runtime;Pi extension 使用 session custom entry replay。
- `/goal <objective>` 和 `/goal resume` 已通过 `pi.sendMessage(..., { triggerTurn: true })` 对齐 Codex 的"命令回车后自动开始/恢复工作"体验。
- **Idle continuation 调度已实现**:`turn_end` 后若 goal 仍 active 且 `ctx.isIdle() && !ctx.hasPendingMessages()`,extension 会通过 `pi.sendMessage({triggerTurn:true})` 启动一次自动续跑 turn,直到模型自行调用 `update_goal({status:"complete"|"blocked"})`、用户介入、或 budget 耗尽切到 `budget_limited`。`continuationInFlight` flag 防止 turn_end 抖动重复触发。
- **continuation prompt 仅在自动续跑 turn 注入**:普通用户 turn 上 `before_agent_start` 不再叠加 continuation prompt(节省每轮数千 token);只有 budget_limited 状态会注入 wrap-up steering。这与 Codex `mark_thread_goal_continuation_turn_started` 一致。
- **token accounting 实时化**:每次 `tool_execution_end`(除 update_goal 自身)都重算 usage,跨过 budget 立刻切 `budget_limited`,下一轮 turn 即可看到 wrap-up steering。先前只在 `before_agent_start` / `turn_end` 结算,一个 turn 内连烧多个 tool 会延迟到 turn 结束才发现超额。
- `update_goal` 现在与 Codex 一致接受 `complete | blocked` 两种 status。`blocked` 表示模型在严格审计下达到 3 轮以上同一卡点,需要用户介入。`continuationPrompt` 已加回 Blocked audit 段。
- `/goal resume` 不再允许从 `budget_limited` 恢复(终态);需用户输入新 objective 或调整预算。允许从 `paused` / `blocked` 恢复。
- statusLine 改用 codex 风格紧凑格式化:`Pursuing goal (1.2K / 50K)` / `Goal achieved (1h 30m)`,长 token 数不再字面爆视图。
- `/goal pause`、`/goal resume`、`/goal clear` 是 Pi 侧人工操作命令,Codex 工具契约不暴露这些能力给模型。

仍未对齐的差异(YAGNI 范围之外):

- Codex 还有 `usage_limited` 状态(API rate limit 级)、`paused` 与 `blocked` 在 metrics 上的细分、以及 plan-mode 抑制 idle continuation 的开关 — Pi 这边目前只暴露 idle continuation 全开,没有 plan-mode 联动。
- token 增量公式:Pi 使用 `usage.input + usage.output`,假设 provider 已把 cached input 排除在 `usage.input` 之外;codex 显式 `non_cached_input + output`。如果未来某个 provider 把 cache 算进 input,需要改 `totalTokenUsage` 减去 `usage.cacheRead`。

这些差异来自 Pi extension API 的运行模型,不影响三个模型工具的外部契约。
