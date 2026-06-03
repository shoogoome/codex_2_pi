# D2 — InProcessTeammate Collaboration & Full TUI Design

**Date:** 2026-06-03
**Status:** Draft (D2 = D 期子项目 2/2)
**Continues:** D1 (`docs/superpowers/specs/2026-06-03-d1-teammate-core-design.md`)

---

## 1. Scope

D2 在 D1 基础上补齐"团队真正能协作"所需要的剩余 4 块:

| 模块 | 内容 | 影响范围 |
|---|---|---|
| **A. team_task list** | `team_task_create / update / list / get` 工具 + jsonl 派生持久化 | 新增 `extensions/teammate/teamTasks/` 模块 |
| **B. plan-mode approval handshake** | teammate 进 plan mode → 发 plan_approval_request,leader 批准后才执行 | sendMessage 协议体扩展 + teammateLoop 处理逻辑 |
| **C. permission sync** | teammate 的 tool permission prompt 路由到 leader 集中决策 | spawnTeammate 注入 permission handler + leader-side 收 prompt → ui.confirm |
| **D. TUI view-swap** | 方向键选 teammate / 回车进 teammate context / 再回车回 leader / k 键 kill | `extensions/teammate/ui/viewSwap.ts` + 全局 keybindings |

**D1 遗留问题(D1.5 — 本期已解决)**:teammate 主动通知 leader 的整条链路在 D1 实际是断的;根因分析、修复与真实 LLM 验证见 **§1.5**。修复后 teammate 调 `send_message {to:"leader"}` / 广播 `*` 能可靠地以 `triggerTurn:true` 立即唤醒主 LLM(idle→`prompt`,streaming→`steer`,均不卡死)。D2 其余模块(B/C 的 leader→teammate 回包)应复用 §1.5 的同质机制(进程级 bridge + spawn 时注入身份),而不要重蹈 ALS / eventBus-handle 跨 realm 失效的覆辙。

## 1.5 D1.5 — teammate→leader 通知链路修复

**背景:** D1 实跑(真实 LLM，3 个 teammate 各发三轮消息)中发现 leader 从未收到 teammate 的消息，只收到 `idle` 通知。逐层 spike 定位出三个叠在一起的根因，全部源于「teammate 跑在独立 sub-session + 独立扩展 realm」这一架构事实。

### 根因(三层，spike 实证)

1. **链路投递错 session（eventBus / handle 跨 realm 隔离）**
   - `spawnTeammate` 用 `createAgentSessionServices()` 为每个 teammate 建 sub-session，**不共享** leader 的 eventBus → sub-session 的 `resourceLoader` / eventBus / 扩展 runtime 全是独立实例（spike 实证 `eventBus same? false`）。
   - `handle.ts` 把 `TeammateHandle`（mailbox/teamStore）挂在 `pi.events`（=eventBus）上，所以 sub-session 里的 teammate 扩展拿到的是**自己那份**隔离 handle。teammate 调 `send_message` 走 `getTeammateHandle(pi)` / `postLeaderNotification(pi)` 时，投递进的是 sub-session 自己的 mailbox / 自己的 jsonl，leader 永远收不到。

2. **`send_message` 工具在 teammate sub-session 里根本没注册**
   - teammate 扩展原本在 `session_start` 回调里 `pi.registerTool(send_message)`。而 sub-session 是用 `session.prompt()` 驱动的，**从不调 `bindExtensions()` → 永不触发 `session_start`** → 该工具在 sub-session 里从未注册。
   - 现象：teammate 报告自己可用工具里没有 `send_message`（也没有 `bash`），只能干瞊眼。`spawnTeammate` 把名字放进 `tools` 白名单也没用——白名单只是「允许激活」，registry 里不存在的工具激活不了。

3. **身份解析依赖的 ALS 跨 realm 失效**
   - `als.ts` 的 `storage = new AsyncLocalStorage()` 是模块级单例。`teammateLoop` 在 **leader realm** 调 `runAsTeammate(identity, …)`，而 send_message 工具运行在 **sub-session realm**，两个 realm 是不同的 `AsyncLocalStorage` 实例 → `getCurrentTeammate()` 返回 `undefined` → `from` 误判为 `"leader"`，且 `if (identity && …)` 的 leader-notify 分支被跳过（spike 实证 `other-realm getCurrentTeammate: undefined`）。

### 修复

| 层 | 修复 | 文件 |
|---|---|---|
| 投递跨 session | **进程级 bridge**：`globalThis[Symbol.for("pi.teammate.leaderBridge")]` 注册表（jiti 跨 realm 共享，spike 实证）。leader 在 `session_start` 注册一个 `LeaderChannel`，其 `deliver` 闭包捕获 **leader 自己的** `pi.sendMessage`；`session_shutdown` 按 sessionId 注销。teammate 侧通过 `getLeaderChannel().deliver(...)` 投递。 | `leaderBridge.ts`、`index.ts` |
| 工具缺失 | 把**通用** `send_message` 注册从 `session_start` 提到 **factory 顶层**（对齐 imagegen 的成熟做法，顶层在每个 session 加载时都跑）。leader-only 工具（`team_create`/`team_delete`）仍留 `session_start`。 | `index.ts` |
| 身份解析 | 不再依赖 ALS。`spawnTeammate` 在建 sub-session 时，把一个 **identity 绑定在闭包里**的 `send_message` 作为 `customTools` 注入，覆盖通用版（spike 实证 customTool 覆盖 + 白名单激活）。该工具直接走 leaderBridge，完全不碰 sub-session 的 mailbox/handle/ALS。 | `tools/teammateSendMessage.ts`、`spawnTeammate.ts` |

**stale 免疫（spike 实证）：** runner 级 `invalidate` 的唯一真实触发点是 leader 自身的 `AgentSession.dispose()`（及 newSession/fork/reload）；teammate sub-session 活跃**不会**让 leader stale。因此桥里捕获的 leader 投递入口在 leader 整个生命周期内有效，`triggerTurn:true` 立即唤醒在 idle（`prompt`）/ streaming（`steer`）两态均安全、不卡死——直接满足「长任务等待 teammate 反馈不能卡死」的诉求。

### 验证

- 单元：`leaderBridge.test.ts`（含 `?realm=2` 动态 import 模拟跨 realm 共享）、`tools/teammateSendMessage.test.ts`（identity-bound + bridge 投递 + 协议识别）、`index.test.ts`（顶层注册 send_message / session_start 只注册 leader-only 工具 / channel 注册-注销）、`tools/sendMessage.test.ts`（有 channel 走 bridge、sub-session pi 不再误收）、`spawnTeammate.test.ts`（customTools 注入断言）。`npm test` = **643 passed**，`tsc --noEmit` 干净。
- 真实 LLM 端到端：3-teammate「各发三轮 + 完成通知」case，leader 实际收到 `[from memberC@demo-team] memberC 三轮结束` 等 `kind:"message"` 通知（此前只有 `idle`）。

### 对 D2 后续模块的约束

**通信方向矩阵(本期 D2 关心的三类协议消息):**

| 方向 | leader 起 | teammate 起 |
|---|---|---|
| → leader | (n/a) | ✅ leaderBridge(D1.5)。teammate 的 customTool 直接 `getLeaderChannel().deliver(...)` 注入 leader 主 LLM,`triggerTurn:true` 立即唤醒。 |
| → teammate | ✅ leader 自己调 `send_message {to:"<name>"}`,工具运行在 leader realm,`getTeammateHandle(pi)` 拿到的就是 leader 自己的 mailbox,直接 `mailbox.send` → teammateLoop 的 receiver。**不需要新桥**。 | ⚠️ peer↔peer 当前没打通。 |

**等待型工具(request-response)的范式:**

`request_plan_approval` / 未来的 `request_permission` 这类需要 *teammate 调用工具后 await leader 回包* 的工具,必须按 D1.5 的 customTool 注入范式做,但 promise 要**挂在 leader realm**:

```
spawn 时(leader realm):
  pendingApprovals = new Map<requestId, { resolve, reject }>()
  customTools = [
    buildTeammateSendMessageTool(identity),
    buildRequestPlanApprovalTool({ identity, pendingApprovals, leaderChannel }),  // 闭包捕获 leader-realm map
  ]

teammate sub-session 调 request_plan_approval:
  reqId = uuid()
  promise = new Promise((resolve, reject) => pendingApprovals.set(reqId, { resolve, reject }))
  leaderChannel.deliver({kind:"message", body: JSON.stringify({type:"plan_approval_request",...})}, true)
  return await promise  // <- 这个 promise 实际是 leader-realm 的 Map 在持有

teammateLoop(leader realm)收到 plan_approval_response:
  pendingApprovals.get(reqId)?.resolve(...)
```

**关键点 — pendingApprovals 必须 leader-realm,不能 ALS、不能 sub-session-local。** 跨 realm resolve 跨不过去,这是 D1.5 已经踩过的坑。

- **Module B**(plan-mode):严格按上述范式做。protocol.ts 加 `plan_approval_request` / `plan_approval_response` 两个 kind,buildRequestPlanApprovalTool 是 customTool。teammateLoop 协议路由扩展。
- **Module C**(permission sync):**Phase 0 spike 已确认 Path B**(详见 §4)。Pi SDK 未暴露 permission decision hook,permissionBridge.ts 不做。改为限制 teammate 工具池(read/find/grep/ls 等只读)+ 强 prompt 引导 + 让 teammate 通过 send_message 向 leader 请求执行需权限操作的方式。
- **peer↔peer**:本期 out-of-scope。若需要,在 leaderBridge 上扩展按 agentId 寻址的多端注册即可,无需新模块。

## 2. Module A — team_task list

### 2.1 数据模型

```ts
// extensions/teammate/teamTasks/types.ts
export interface TeamTask {
  id: string;                          // 类似 "tt-3akj9d2x"
  teamName: string;
  subject: string;                     // 短描述
  description?: string;                // 详细文本
  status: "pending" | "in_progress" | "completed";
  owner?: string;                      // teammate agentName / "leader" / undefined
  blockedBy: string[];                 // 其他 task id
  blocks: string[];                    // 衍生:此 task 阻塞的下游 task ids
  metadata?: Record<string, unknown>;  // 自由扩展
  createdAt: number;
  updatedAt: number;
}

export type TeamTaskEvent =
  | { kind: "team_task_create"; task: TeamTask }
  | { kind: "team_task_update"; taskId: string; teamName: string; patch: Partial<TeamTask>; updatedAt: number }
  | { kind: "team_task_delete"; taskId: string; teamName: string };
```

### 2.2 jsonl 持久化

复用 D1 的 `teammate/event` customType。reducer 在 `jsonlEvents.ts` 里扩展处理这 3 个新 kind。
- `team_task_create` → 注册 task
- `team_task_update` → patch 应用
- `team_task_delete` → 移除

team task 状态归入现有 `ReplayedState`:增加 `teamTasks: Record<string, TeamTask>`。

### 2.3 Store

`extensions/teammate/teamTasks/teamTaskStore.ts` — 镜像 `teamStore.ts` 模式(immutable snapshot + subscribe + listeners)。挂在 `TeammateHandle` 下:

```ts
export interface TeammateHandle {
  teamStore: TeamStore;
  mailbox: Mailbox;
  teamTaskStore: TeamTaskStore;     // 新增
}
```

`getTeammateHandle(pi)` 拿到 handle 后所有需要 task list 的代码都从这里读。

### 2.4 Tools

| Tool | 参数 | 行为 |
|---|---|---|
| `team_task_create` | `team_name`, `subject`, `description?`, `blocked_by?[]`, `metadata?` | 生成 id,写 jsonl + store |
| `team_task_update` | `task_id`, `subject?`, `description?`, `status?`, `owner?`, `blocked_by?[]`, `metadata?` | patch 应用 |
| `team_task_list` | `team_name?`(默认从 ALS 拿当前 teammate 的 team), `status?`, `owner?` | 查询 + 排序(blockedBy 解析) |
| `team_task_get` | `task_id` | 单条 |

LLM-facing description 强调:
- 用于 leader 把工作拆给 teammate(set `owner`)
- teammate 接活时 `team_task_list {status:"pending", owner: undefined}` + `team_task_update {owner: "<self>", status:"in_progress"}`
- 完成后 `status:"completed"`
- `blocked_by` 阻塞表达式

### 2.5 Reducer scope 扩展

`jsonlEvents.ts` 加 3 个 kind 的处理。`hydrateTeammateState` 自动消费(它本就是泛用的 reducer wrapper)。

## 3. Module B — plan-mode approval handshake

### 3.1 协议

复用 SendMessage 的协议消息机制(D1 已有 shutdown handshake 的同质架构):

```ts
// 新协议体
{type: "plan_approval_request", request_id: "p-1", plan: "Step 1: ..."}
{type: "plan_approval_response", request_id: "p-1", approve: true, feedback?: "tweak step 2"}
```

### 3.2 触发时机

**Teammate 侧**:teammate 在 LLM 决定要执行写动作之前(目前简化为:teammate **主动调用** `request_plan_approval` tool — 我们新增这个 tool 给 teammate 用)。

新增 tool:
```ts
// 仅 teammate 可见(not registered for leader)
request_plan_approval {plan: "<plan text>"}
```

行为:
1. 生成 request_id
2. 通过 mailbox 发给 leader (复用 sendMessage 的 leader notification 通道)
3. teammate **暂停** —— `await` 直到收到 plan_approval_response
4. 收到 approve:true → 工具返回 success,LLM 继续执行;否则返回 isError + feedback

**Leader 侧**:已有 send_message 工具就够用 — leader 接到 plan_approval_request 后调 `send_message {to:"<teammate>", message: '{"type":"plan_approval_response","request_id":...,"approve":true}'}`。

(可选优化)leader 可见的便捷工具 `team_plan_approve {teammate, request_id, approve, feedback?}` —— 这只是 send_message 的 wrapper,语法糖。**D2 决定:做这个 wrapper**,LLM 用起来更顺。

### 3.3 teammateLoop 改造

`teammateLoop.ts` 的协议路由扩展:
```ts
const protocol = detectProtocol(msg.body);  // 返回 "shutdown_request" | "plan_approval_response" | undefined
switch (protocol) {
  case "shutdown_request": ...(已有)
  case "plan_approval_response":
    // 解 request_id 找 pending request,resolve 它的 promise
    pendingPlanApprovals.get(reqId)?.resolve({approve, feedback});
    break;
  default: 普通 user message
}
```

`request_plan_approval` tool 在执行时把 promise 注册到 teammate-local map,等 plan_approval_response 来 resolve。**实现要点**:这个 map 是 teammate's 内存,跨 reload 不存。reload 后 LLM 应能重发请求。

### 3.4 协议扩展点

为后续 D3+ 做准备,把 `shutdownHandshake.ts` 改名 `protocol.ts`(或新建 `protocol.ts` 让 shutdown 加 plan 一起放),用 discriminated union + parse/build 函数族表达多种协议。

## 4. Module C — permission sync(spike 后:Path B 降级)

### 4.1 spike 结论

**两个并行 spike(0.1)反复确认:**
- `AgentSessionServices` / `CreateAgentSessionFromServicesOptions` **没有** `permissionHandler` / `onPermissionRequest` 类的 hook(spike 1)
- `AgentSession.agent.beforeToolCall` 是 SDK **内部已占用**的 public 字段,直接赋值会覆盖 SDK 装好的 `_extensionRunner.emitToolCall` 调度器 —— 破坏 extension 事件流(spike 2 实证 hook 存在,但漏掉了"已被占用")
- `pi.on("tool_call", handler) → {block:true, reason}` 是**官方拦截通道**(`extensions/types.d.ts:714`),但 teammate sub-session 由 `session.prompt()` 驱动、**不调 `bindExtensions()`** → 我们的扩展在 sub-session realm 根本没机会注册 tool_call handler

结论:**SDK 在 sub-session 拦截 permission 没有干净路径**。三种思路都有破坏面:
1. 给 sub-session 调 bindExtensions() → 触发整个 teammate extension 在 sub-session 重复加载,递归创建 leaderBridge / mailbox / handle
2. 覆盖 `session.agent.beforeToolCall` → 失去 SDK extension event 路由
3. 注入 permission proxy 进 services → SDK 没暴露面

### 4.2 Path B — 工具池剪裁 + prompt 引导 + leader 代理

不做 `permissionBridge.ts`。改为:

**4.2.1 spawn 时收紧 teammate 的工具池**

`spawnTeammate.ts` 的 `TEAMMATE_TOOLS_BLOCKLIST` 扩展为同时屏蔽**写型工具**:

```ts
const TEAMMATE_TOOLS_BLOCKLIST = new Set([
  // recursion guards (D1)
  "task_agent", "team_create", "team_delete",
  // D2 C: write-class tools — teammate must request leader to do these
  "bash", "write", "edit", "task_bash", "task_kill",
]);
```

teammate **保留**:read / find / grep / ls / send_message / request_plan_approval / team_task_*。这些是只读 + 通信工具,不会改文件系统/起进程。

**4.2.2 强 prompt 引导**

`teamCreate` / `task_agent` spawn teammate 的 prompt boilerplate 里加固一段:

> 你是 team `<name>` 的成员 `<agentName>`。**你没有 bash / write / edit 权限** —— 这是设计如此,不是配置错误。如果任务需要写文件、跑命令、改代码,请用 `send_message {to:"leader", message:"请帮我 ..."}` 让 leader 代为执行。`send_message` 是你与 leader 协作的唯一通道,leader 收到会立即唤醒并执行。

这段固化在 spawn 时拼进 initialPrompt(可由 leader 在 `task_agent {prompt:...}` 时覆盖)。

**4.2.3 不做的事**

- ❌ 不做 leader-side ui.confirm 弹框(没有 sub-session permission hook 可以触发它)
- ❌ 不实现 `permission_request` / `permission_response` 协议消息(LLM 自然语言已足够)
- ❌ 不做 `extensions/teammate/permissionBridge.ts`

### 4.3 风险与权衡

| 风险 | 缓解 |
|---|---|
| LLM 不读 prompt,一上来就调 bash / write 报错 | 工具池里就没这些工具,LLM 看到的就是没 bash,自然走 send_message 路径 |
| LLM 试图通过 task_agent 套娃绕过 | task_agent 也在 blocklist,递归被切断 |
| Leader 收到 "请帮我 写 X" 后忘了真去做 | 这是 leader 的 LLM 决策问题,不在 teammate 安全模型内;cooperative 失败 |
| 未来真要加 permission hook | 等 Pi SDK 暴露 sub-session permission API 时再升 Path A |

### 4.4 文件影响

**只动两处:**
- `spawnTeammate.ts` — 扩展 BLOCKLIST + 在 prompt 前置 boilerplate
- `tools/teamCreate.ts` — 不变(用 leader 自己的 prompt;约束语在 spawnTeammate 加)

**不新增** `permissionBridge.ts` / `permissionBridge.test.ts`。Module C 缩减至 ~50 行 prod + ~80 行测试。

## 5. Module D — TUI view-swap(spike 后:Path A 完整可行)

### 5.1 模型

leader 的 TUI 有两种 view 状态:
- **leader view**(默认):主对话流是 leader's session
- **teammate view**:输入框被替换为发往 teammate 的输入,主区域 overlay 渲染 teammate 的最近消息

切换:
- `Tab` / 方向键(↑↓):在 widget 中循环高亮 teammate
- `Enter`(leader view、有 teammate 高亮):进入选中 teammate 的 view(setEditorComponent + 启动 teammate session 监听)
- `Enter`(teammate view、空输入框):退回 leader view
- `k` kill 选中的 teammate
- `Esc` 取消高亮 / 退出 teammate view

### 5.2 spike 结论(0.2)

Pi SDK 完整暴露所需 API:

| API | 用途 |
|---|---|
| `ctx.ui.setEditorComponent(factory)` | 替换主输入框为 teammate 输入组件;`factory(tui, theme, kb) → EditorComponent` |
| `ctx.ui.onTerminalInput(handler)` | 注册原始键盘 handler;`handler(data) → {consume?: boolean, data?: string}` 可消费/改写按键 |
| `ctx.ui.custom<T>(factory, {overlay:true, overlayOptions})` | 弹出 overlay 组件,异步等待 done(result) |
| `ReadonlySessionManager.getEntries()` (在 leader 的 ctx 持有的 sessionManager) | 读 entries 自渲染 teammate session 内容到 widget |

注:`setWidget` 仅支持 `aboveEditor` / `belowEditor`,不支持 fullscreen。**所以"主对话流被 overlay"用 `ui.custom({overlay:true})` 而非 setWidget**。

### 5.3 实现思路

```ts
// extensions/teammate/ui/viewState.ts
type ViewState =
  | { kind: "leader" }
  | { kind: "leader_with_selection"; selectedAgentId: string }
  | { kind: "teammate"; agentId: string };

// ui/teamWidget.ts(已存在,扩展):
//   高亮 selectedAgentId,行前加 "▶ "

// ui/keybindings.ts(新增):
//   注册 ctx.ui.onTerminalInput,根据当前 view 状态:
//   - leader view:↑↓ 切 selection;Enter 进 teammate view;Esc 取消;k kill
//   - teammate view:Enter 空输入框 退;k kill 当前 teammate

// ui/viewSwap.ts(新增):
//   enter(agentId): ctx.ui.setEditorComponent(makeTeammateEditor(agentId, sessionManager))
//   exit(): ctx.ui.setEditorComponent(undefined) → 回默认编辑器
//   teammateEditor 的 handleInput 接收用户输入,Enter 时 leader-realm 直接调 mailbox.send({to: agentId, body, from:"leader"})
//   render 调 sessionManager.getEntries() / 或读 teammate session jsonl 直接 → render text array
```

### 5.4 退路

如果实施时发现 `setEditorComponent` 与 leader 自己的 prompt 输入冲突,降级到 Path B(只做 widget 高亮 + `k` kill + Enter 弹 `ui.custom` 让用户输入消息后送 mailbox)。Plan 里 D.4 任务保留这个 A/B 分叉。

## 6. File Structure

```
extensions/teammate/
  teamTasks/                              ⬅ 新增模块 A
    types.ts                              TeamTask + TeamTaskEvent
    teamTaskStore.ts                      in-memory store
    teamTaskStore.test.ts
    tools/
      teamTaskCreate.ts
      teamTaskCreate.test.ts
      teamTaskUpdate.ts
      teamTaskUpdate.test.ts
      teamTaskList.ts
      teamTaskList.test.ts
      teamTaskGet.ts
      teamTaskGet.test.ts
  protocol.ts                             ⬅ 重命名/扩展 shutdownHandshake.ts
  protocol.test.ts                        含 plan_approval / permission 协议
  permissionBridge.ts                     ⬅ 新增模块 C(可能降级)
  permissionBridge.test.ts
  tools/
    requestPlanApproval.ts                ⬅ 新增模块 B(teammate-side tool)
    requestPlanApproval.test.ts
    teamPlanApprove.ts                    ⬅ 新增模块 B(leader-side wrapper)
    teamPlanApprove.test.ts
  ui/
    viewSwap.ts                           ⬅ 新增模块 D
    viewSwap.test.ts
  jsonlEvents.ts                          ⬅ 扩展:加 3 个 team_task event kind
  hydrate.ts                              ⬅ 扩展:消费 team_task events
  handle.ts                               ⬅ 扩展:暴露 teamTaskStore
  spawnTeammate.ts                        ⬅ 扩展:permission proxy + view-swap registration
  teammateLoop.ts                         ⬅ 扩展:plan_approval / permission 协议路由
  index.ts                                ⬅ 扩展:注册 4 个 team_task tools + plan/permission tools + view-swap UI
```

## 7. Test Plan(预估)

| 模块 | 单元 | 集成 | 真 LLM |
|---|---|---|---|
| A. team_task list | reducer + store + 4 个 tool execute | hydrate replay 含 task | leader 拆 task,teammate 接活 → 完成 |
| B. plan-mode | protocol parse/build + tool execute + loop 路由 | end-to-end approval cycle | teammate 调 request_plan_approval,leader approve |
| C. permission | spike + bridge logic + send/recv loop | end-to-end allow/reject cycle | teammate 调 write,leader 弹框 |
| D. TUI view-swap | viewSwap render逻辑 + key handler | snapshot test for overlay | TUI mode 手动 |

预估:**~3000 行 prod / ~2200 行测试,~30 个 Task**(分 6 phases:Spike → A → B → C → D → 集成 + 真 LLM)。

## 8. Risks

| Risk | 缓解 |
|---|---|
| ~~主 pi stale-ctx 限制（D1 已知）~~ | **已解决（D1.5）**— 详见 §1.5；teammate→leader 走进程级 leaderBridge + AgentSession 实例级投递入口，跨过 stale 闸门 |
| `createAgentSessionServices` 暴露 permission API | D2 plan 第一步 spike；若不能 hijack，降级到 dangerous-skip + 强 prompt 引导 |
| `setEditorComponent` + 全屏 overlay 复杂度 | spike；fallback 到键盘选 teammate + 弹 dialog |
| reload 后 plan_approval / permission pending 请求丢失 | 接受这一损失（很少见），document |

## 9. Out-of-Scope (D3+ if any)

- 跨 session UDS / remote bridge
- Plan-mode 自动检测(LLM 自己识别"我要写文件,请审")
- Permission 持久化(每次都问)
- TUI 的高级功能(光标移动跟踪 / 多 widget 协作)
