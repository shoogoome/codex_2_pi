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

**已知遗留问题(D1 留作 D1.5,本期暂不解决)**:teammate `onIdle` 时通过主 `pi.sendMessage(triggerTurn:true)` 唤醒主 LLM 受 stale-ctx 限制,目前走 `appendCustomMessageEntry` 写盘的路径在主 LLM 下次开口时才被读到。D2 各模块在设计时**避免依赖"立即唤醒主 LLM"** — 通信都走 jsonl 派生 + LLM 主动消费 + ctx hook 注入的机制。

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

## 4. Module C — permission sync

### 4.1 现状

每个 sub-AgentSession (teammate) 用了主 pi 的 services。Pi 的 services 包含 permission handler — 当 teammate 的 LLM 调用一个需要 permission 的 tool(如 write/bash),Pi **会**走 permission flow,**默认**触发 ctx.ui.confirm 在 teammate 的 ctx 里。

但 teammate **没有自己的 UI** — 它是 sub session,没有 TUI 界面。所以 ctx.ui.confirm 在 sub session 里默认是 noop / 自动 reject。

### 4.2 设计

劫持 teammate 的 permission flow,把请求**通过 mailbox 发给 leader**,leader 用其自己的 ctx.ui.confirm 弹框 → 答复 → 沿原通道返回。

具体:
- `extensions/teammate/permissionBridge.ts` — 在 spawnTeammate 创建 services 时,**包一层 permission proxy**(替换 services 的某些方法)。当 teammate 走到 permission check 时,proxy:
  1. 生成 permission_request id
  2. 发给 leader: `send_message {to:"leader", message:'{"type":"permission_request","request_id":"...","tool":"...","args":...}'}`
  3. teammate 暂停(promise pending)
  4. leader 收到 → 通过 send_message 答复 `permission_response`
  5. promise resolve → permission proxy 返回 allow/reject

可问题:**Pi 的 createAgentSessionServices 暴露 permission handler 吗?** 需要 spike 验证(D2 plan 第一步)。如果不能 hijack,Plan B:teammate 启动时**预设 dangerous-skip 模式**(认为 leader 已经预批所有权限),**不走 prompt**,纯靠 prompt 引导 LLM 注意安全。这是降级路径。

我建议先按 spike 看 services 长什么样;如果 hijack 不到,**就走 dangerous-skip + 强 prompt 引导** —— 这本来就是当前默认行为(没 prompt 就 hang)。

## 5. Module D — TUI view-swap

### 5.1 模型

leader 的 TUI 有两种 view 状态:
- **leader view**(默认):主对话流是 leader's session
- **teammate view**:主对话流被替换成所选 teammate's session

切换通过键盘:
- `Tab` 或方向键(↑↓)在 widget 中循环高亮 teammate
- `Enter` 进入选中 teammate 的 view(focus 切到 teammate's session)
- `Enter`(在 teammate view 中)退回 leader
- `k` kill 选中的 teammate
- `Esc` 取消选中(回到默认)

### 5.2 实现关键

Pi 提供:
- `pi.ui.setEditorComponent(factory)` — 可以替换 prompt 输入框组件
- `pi.ui.setWidget(key, content, opts)` — 已用,显示 team 状态
- `pi.ui.onTerminalInput(handler)` — 监听原始键盘输入(interactive 模式)

view-swap 的核心:teammate 自己的 messages stream 怎么显示在 leader 的主对话流里?**Pi SDK 没有直接 API 让 extension 替换主 messages stream**。我们能做到的:

1. **不真的"替换" messages stream**,而是用 `pi.ui.setWidget` 显示一个**全屏 overlay** widget,覆盖主对话流,内容渲染 teammate's session jsonl(通过 `SessionManager.open(<teammate's jsonl>)` 读 entries 渲染)。
2. teammate 的输入:用 `pi.ui.setEditorComponent` 替换 prompt 输入,新输入框拦截 Enter → 直接 `send_message {to:<currentTeammate>}` 投递,不走 leader's prompt。
3. 退出 teammate view:还原 widget + editor。

**spike 必要**:D2 plan 第一步需要 spike 验证 `setEditorComponent` + `setWidget(全屏 overlay)` 的可用性。

### 5.3 简化路径

如果 D2 spike 发现 `setEditorComponent` + 全屏 overlay 太复杂,fallback:
- 仅做"键盘选 teammate + Enter 弹一个 Pi 提供的 dialog 让 leader 输入消息发给 teammate"
- 不接管整个 view 流

跟用户决策一致 ("对齐 claudecode" 偏 full view-swap),但保留 fallback 选项。

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
| 主 pi stale-ctx 限制(D1 已知) | D2 设计避开"立即唤醒",改为 jsonl + ctx-inject + LLM 主动消费 |
| `createAgentSessionServices` 暴露 permission API | D2 plan 第一步 spike;若不能 hijack,降级到 dangerous-skip + 强 prompt 引导 |
| `setEditorComponent` + 全屏 overlay 复杂度 | spike;fallback 到键盘选 teammate + 弹 dialog |
| reload 后 plan_approval / permission pending 请求丢失 | 接受这一损失(很少见),document |

## 9. Out-of-Scope (D3+ if any)

- 跨 session UDS / remote bridge
- Plan-mode 自动检测(LLM 自己识别"我要写文件,请审")
- Permission 持久化(每次都问)
- TUI 的高级功能(光标移动跟踪 / 多 widget 协作)
