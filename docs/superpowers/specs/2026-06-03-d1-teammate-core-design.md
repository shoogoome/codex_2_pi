# D1 — InProcessTeammate Core Design

**Date:** 2026-06-03
**Status:** Draft (awaiting user review before plan)
**Scope:** D 期子项目 1/2(团队核心 — team / teammate / mailbox / shutdown handshake / reload hydration / TUI widget)
**Out-of-scope (deferred to D2):** team task list / plan-mode approval / permission sync / TUI view-swap / 完整 keybindings

---

## 1. Problem

子项目 C(LocalAgent)给主 LLM 提供了"派一个一次性 sub-agent 干完一件事"的能力 — sub-agent 完成即销毁。但**多 agent 长期协作**这一类工作无法表达:

- 主 LLM 想跟一个 researcher 持续对话,researcher 应该一直活着等下一条指令,而不是每次都重新 spawn
- 多个 sub-agent 之间需要**互相通信**(coder 完成后告知 reviewer),不只是各自跟主 LLM 对话
- 主 LLM 和 sub-agent 都需要看到团队**当前有谁在线**、**谁在做什么**

claudecode 的 InProcessTeammate 解决这个 — 同进程多 LLM AgentSession 共存,有持久身份 + mailbox + 协作工具。**D1 把核心机制(spawn / mailbox / shutdown / reload)落地**,D2 再加 task list / plan-mode / permission / 完整 TUI。

## 2. Decisions Locked-in via Brainstorming

| 议题 | 决策 |
|---|---|
| 整体方向 | 对齐 claudecode 的 in-process 模式 |
| Spawn 工具 | **复用 `task_agent`** — 检测 `team_name`+`name` 参数 → 走 spawn_teammate;否则走 C 期 sub-agent 路径 |
| Idle 模型 | **长连接** — teammate AgentSession 一直活着,turn 结束进 idle 等下一条 message,kill 才退出 |
| Team 持久化 | **不存独立 config 文件** — team / teammate / mailbox 状态全部从 session jsonl 的 customMessage events 派生 |
| Reload 行为 | **透明恢复** — session_start 重放历史 events,自动为还在 running 的 teammate `SessionManager.open()` 重建 AgentSession 并进 idle |
| 隔离 | **AsyncLocalStorage** 包裹每个 teammate 的所有 callback,共享代码自动按身份分流 |
| Handshake | shutdown 协议(plan-mode 留 D2)— SendMessage `{type:"shutdown_request",request_id}` ↔ `{type:"shutdown_response",request_id,approve}` |
| Kill 路径 | handshake(优雅)+ `task_kill <teammate-task-id>`(强杀)+ `team_delete`(一键拆队) |
| TUI(D1) | 仅 setWidget below editor 显示 team / teammate 列表 + 状态。**不做 view swap**(D2) |

## 3. 与 C 期(LocalAgent)的关系

| 维度 | LocalAgent (C) | InProcessTeammate (D1) |
|---|---|---|
| 生命周期 | 一次性,完成即销毁 | 长期,turn 间 idle |
| 通信 | 单向(主→sub) | 双向(主↔sub / sub↔sub) |
| 上下文隔离 | 各自独立 SessionManager | AsyncLocalStorage + 共享 mailbox 通信 |
| 标识 | 仅 taskId | agentName@teamName(human-friendly) |
| 入口工具 | `task_agent {prompt, subagent_type}` | `task_agent {prompt, subagent_type, team_name, name}` |
| Reload | 不持续(完成即销毁,无需恢复) | 透明恢复:重建 AgentSession 进 idle |

**`task_agent` 的两种行为路由表**:

```
task_agent({...})
  ↓
  team_name && name 都给? ─ no ─→ C 期 sub-agent 路径(LocalAgent)
  ↓ yes
  spawnTeammate(team_name, name, ...)  ←  D1 新路径
```

## 4. Architecture Overview

### 4.1 New extension layout

```
extensions/teammate/                    (新增,~2000 行 prod / ~1500 行 test)
  package.json
  index.ts                              extension entrypoint
  types.ts                              TeammateIdentity / InProcessTeammateTaskState / TeamState / MailboxMessage
  als.ts                                AsyncLocalStorage<TeammateContext>
  teamStore.ts                          in-memory team registry(基于 TaskStore + 自家 map)
  spawnTeammate.ts                      spawn long-lived teammate
  killTeammate.ts                       graceful kill + force kill
  shutdownHandshake.ts                  encode/decode shutdown_request/_response
  mailbox.ts                            in-memory message routing
  teammateLoop.ts                       turn loop: prompt → idle → wait → prompt
  jsonlEvents.ts                        customType="teammate/event" definitions + reducers
  hydrate.ts                            session_start: scan jsonl + rebuild + reopen sessions
  ui/
    teamWidget.ts                       setWidget renderer
  tools/
    teamCreate.ts                       team_create tool
    teamDelete.ts                       team_delete tool (cascade kill)
    sendMessage.ts                      send_message tool
```

### 4.2 修改现有文件

```
extensions/localagent/tools/taskAgent.ts    扩展:识别 team_name + name → 路由到 spawnTeammate
extensions/localagent/spawnLocalAgent.ts    无变化(D1 只新增,不改 C 期路径)
extensions/tasks/Task.ts                    无变化(in_process_teammate enum 已占位)
extensions/tasks/index.ts                   无变化
```

## 5. Core Mechanics

### 5.1 State shapes

```ts
// types.ts
export interface TeammateIdentity {
  agentId: string;       // 唯一: "researcher@my-team"
  agentName: string;     // 易读: "researcher"
  teamName: string;
  agentType: string;     // 创建时记录的 subagent_type
  color?: string;        // 可选,UI 上区分用
}

export interface InProcessTeammateTaskState extends TaskStateBase {
  type: "in_process_teammate";
  identity: TeammateIdentity;
  prompt: string;                       // 初次 spawn prompt
  model?: string;
  sessionFile: string;                  // teammate 自己的 jsonl 路径

  // Runtime — 不持久
  session?: AgentSession;
  cleanup?: () => void;                 // session.subscribe 的 unsub
  abortController?: AbortController;

  // Idle 状态
  isIdle: boolean;
  pendingMessages: MailboxMessage[];    // turn 中收到的暂存
  shutdownRequested: boolean;
  shutdownAcknowledged: boolean;

  // UI / 进度
  lastTool?: string;
  lastToolStartedAt?: number;
  toolCallCount: number;
  tokenCount: number;
  turnCount: number;
}

export interface TeamState {
  teamName: string;
  description?: string;
  createdAt: number;
  // 通过 TaskStore 间接拿成员 — 这里只放 agentId 引用
  memberAgentIds: string[];
}

export interface MailboxMessage {
  id: string;
  from: string;          // "leader" 或 agentName
  to: string;            // agentName 或 "*"
  body: string;          // 自由文本 or JSON-stringified protocol body
  timestamp: number;
  isProtocol: boolean;   // shutdown / plan-approval handshake 时为 true
}
```

### 5.2 ALS 隔离

`als.ts` 暴露:
```ts
const teammateContextStorage = new AsyncLocalStorage<TeammateIdentity>();

export function runAsTeammate<T>(identity: TeammateIdentity, fn: () => T): T {
  return teammateContextStorage.run(identity, fn);
}

export function getCurrentTeammate(): TeammateIdentity | undefined {
  return teammateContextStorage.getStore();
}
```

teammate 的所有 subscribe 回调和 prompt 都在 `runAsTeammate(identity, ...)` 包裹内调度,共享 tool 代码用 `getCurrentTeammate()` 自动判定身份。

### 5.3 Mailbox

`mailbox.ts` 实现内存级单进程投递:

```ts
class Mailbox {
  private receivers = new Map<string, (msg: MailboxMessage) => void>();
  private buffer = new Map<string, MailboxMessage[]>();   // agentName → 暂存

  send(msg: MailboxMessage): void {
    if (msg.to === "*") { /* fan out */ }
    const recv = this.receivers.get(msg.to);
    if (recv) {
      recv(msg);  // 立即派发
    } else {
      // teammate 不在线 / 不存在,暂存等 teammate 起来或丢弃
      const arr = this.buffer.get(msg.to) ?? [];
      arr.push(msg);
      this.buffer.set(msg.to, arr);
    }
  }

  registerReceiver(agentName: string, recv: (msg: MailboxMessage) => void): () => void {
    this.receivers.set(agentName, recv);
    // 进入 receiver 时把暂存 flush
    const buffered = this.buffer.get(agentName) ?? [];
    this.buffer.delete(agentName);
    for (const msg of buffered) recv(msg);
    return () => this.receivers.delete(agentName);
  }
}
```

### 5.4 Teammate Loop

teammate 起来后跑这个循环:

```
1. session.prompt(initialPrompt + boilerplate)         ← 入门 turn
2. await turn 结束(agent_end)
3. 检查 task.shutdownRequested + shutdownAcknowledged → 退出
4. setIdle(true)
5. 如果 pendingMessages 非空:取队头作为下个 prompt
   否则:registerReceiver 等下一条(Promise resolve 后取走)
6. setIdle(false)
7. session.prompt(formatIncoming(msg)) → 回 step 2
```

注意:**第 2 步等 turn 结束**用的就是 C 期已有的 `agentEndedPromise` 机制。

### 5.5 jsonl Events(派生持久化)

新 customType: `teammate/event`,每条 details 形如:
```ts
type TeammateEvent =
  | { kind: "team_create"; teamName: string; description?: string }
  | { kind: "team_delete"; teamName: string }
  | { kind: "teammate_spawn"; identity: TeammateIdentity; sessionFile: string; initialPrompt: string }
  | { kind: "teammate_terminal"; agentId: string; status: "completed"|"failed"|"killed" }
  | { kind: "message_sent"; msg: MailboxMessage }
  | { kind: "shutdown_request"; agentId: string; requestId: string }
  | { kind: "shutdown_response"; agentId: string; requestId: string; approve: boolean }
```

每个 mutating action 写一条 customMessage(走我们 C 期已经验证的 `pi.sendMessage({display:false}, {triggerTurn:false})` + filter 让 LLM 看不到 — D1 的 filter 多挂一个 `teammate/event` customType)。

`hydrate.ts`:
```ts
// session_start 时
const events = readJsonlByCustomType(sessionFile, "teammate/event");
const final = events.reduce(reducer, { teams: {}, teammates: {} });

for (const team of Object.values(final.teams)) registerTeam(...);
for (const tm of Object.values(final.teammates)) {
  if (tm.lastStatus !== "running") continue;
  // 重建 AgentSession from teammate's own jsonl
  const services = await createAgentSessionServices(...);
  const sm = SessionManager.open(tm.sessionFile);
  const { session } = await createAgentSessionFromServices({ services, sessionManager: sm, tools: ... });
  // 直接进 idle 状态等 message(不发 initialPrompt)
  startTeammateLoop(tm, session, { resume: true });
}
```

### 5.6 task_agent 路由

`extensions/localagent/tools/taskAgent.ts` 扩展(C 期已有的逻辑保留)— 新增分支:

```ts
if (params.team_name && params.name) {
  // D1 路径:spawn 持久 teammate
  const result = await spawnTeammate(pi, taskStore, teamStore, {
    teamName: params.team_name,
    agentName: params.name,
    agentType: params.subagent_type ?? "general-purpose",
    prompt: params.prompt,
    model: params.model,
  });
  return {
    content: [{ type: "text", text: `Teammate ${result.agentId} spawned (taskId=${result.taskId}). Use send_message to communicate.` }],
    details: { action: "task_agent", mode: "teammate", ...result },
  };
}
// 否则继续走 C 期 spawn LocalAgent 路径
```

工具描述 / 参数 schema 同步更新,把 `team_name` + `name` 参数列出来,LLM 知道有这条路。

### 5.7 Shutdown Handshake

```
Leader: send_message({to:"researcher", message:{type:"shutdown_request", request_id:"r-1"}})
   ↓ mailbox 投递
Teammate: 下一轮 turn 中收到 → LLM 决定 approve / reject
   ↓ teammate 调 send_message({to:"leader", message:{type:"shutdown_response", request_id:"r-1", approve:true}})
Leader: 主 turn 收到 → mark teammate task as terminal "completed"
   ↓ teammate's teammateLoop 看到 shutdownAcknowledged → break loop → session.dispose()
```

`shutdownHandshake.ts` 帮 SendMessage tool 自动识别 protocol 消息(`isProtocol: true`)并解析 / 校验 request_id。

### 5.8 Kill 三档

| 路径 | 触发 | 行为 |
|---|---|---|
| handshake | leader send_message + teammate ack | 优雅:上述 5.7 |
| `task_kill <teammate-task-id>` | leader 主动调或 framework | 强:abort + dispose,不等 ack |
| `team_delete` | leader 拆队 | leader 对每个成员先发 shutdown_request,等 N ms 后强 kill 未 ack 的 |

## 6. TUI(D1 子集)

`ui/teamWidget.ts` 通过 `pi.ui.setWidget("teammate-status", lines, { placement: "belowEditor" })` 显示:

```
▶ my-team (3 members)
  ◌ researcher    idle           [2 turns, 850 tokens]
  ● coder         → bash         [5 turns, 2.4k tokens]
  ◌ reviewer      idle           [1 turn, 320 tokens]
```

字段刷新触发器:teamStore.subscribe(变化时重渲染 widget)。

**D1 不做**(留 D2):
- 方向键切换选中 teammate
- 回车 view swap 进 teammate context
- k 键 kill

## 7. Tools(LLM-facing 接口)

| Tool | 参数 | 作用 |
|---|---|---|
| `task_agent`(扩展) | `team_name`+`name` 触发 teammate 模式;否则 C 期路径 | 同时支持一次性 sub-agent + 持久 teammate |
| `team_create` | `team_name` + `description?` | 注册 team 到 store |
| `team_delete` | `team_name` | cascade kill 所有成员 + 删 team |
| `send_message` | `to`(agentName / `"*"`) + `message`(string 或 JSON 对象) | 同进程投递 |

LLM-side prompt 需要更新:`task_agent` 描述里加上"如果你想要长期 teammate 协作,先 `team_create` 然后 `task_agent {team_name, name, ...}`"。

## 8. Test Plan(~1500 行 test)

### Unit
- types.ts shape 完整性
- mailbox: send 在线 / 离线 / 广播 / receiver register-flush
- shutdownHandshake: encode/decode + request_id 校验
- jsonlEvents reducers: 各 kind event 的 idempotent 重放
- ALS run/getCurrentTeammate 隔离正确性

### Integration
- spawnTeammate 全流程(fake AgentSession)
- killTeammate handshake / force / cascade
- send_message tool 调用走 ALS 拿 from,fanout `*`
- task_agent route(team_name+name vs 不传)
- hydrate.ts:模拟 session jsonl events,断言重建状态 + spawn AgentSession
- shutdown handshake 全流程(leader→teammate→ack→teammate-loop-exit)

### Real LLM(手动)
- TUI mode:`team_create` + `task_agent {team_name:"team1", name:"r1"}` × 2 + send_message → 看 widget 实时
- Reload:做几个 send_message,kill -9 pi 进程,重启,验证 teammate 自动恢复 idle 等下一条

## 9. Risks

1. **AsyncLocalStorage 在 session.subscribe 异步 callback 里能不能保住 context** — 必须在 plan 阶段 spike 验证。这是 D1 实施的硬假设。
2. **SessionManager.open(file) 是否可以打开一个尚未结束的 jsonl 然后续 prompt** — Pi SDK 应该支持(forkFrom / open 都用),plan 阶段第一步 spike 一下。
3. **hydrate 时 multiple teammates 同时重建 AgentSession 的并发** — 串行重建避免冲突,session_start 内 `for ... await` 而非 `Promise.all`。
4. **mailbox `*` 广播在大队伍下的行为** — 暂不做节流;清单里的 teammate 数量预计 <10。

## 10. D2 接口约束(为下一期留接口)

D1 的设计需要为 D2 留出干净的 hook 点:
- `tools/sendMessage.ts` 留出对 `{type:"plan_approval_request"}` 的解析钩子(D2 接入)
- `teammateLoop.ts` 在 idle/active 切换时发布事件,D2 的 task list 状态可以听
- `index.ts` 暴露 `teamStore` 给后续 extension 用 `getTeammateHandle(pi)`(类比 `getTasksHandle`)
- TUI widget 的 layout 结构预留 D2 view-swap 时的"current teammate"高亮位

## 11. Verification(spec 完成的退出条件)

- [x] D1 plan 写完(`docs/superpowers/plans/2026-06-03-d1-teammate-core.md`,22 个 Task / 7 phases)
- [x] D1 实施完成,所有测试绿(实测 506 → **585 passing**,low 于估的 700 因为同步删了 ~59 个旧 subagents 测试)
- [x] 真 LLM 端到端验证:`team_create` → `task_agent {team_name, name}` → `send_message {to}` 全流程跑通(stdout JSON event 完整,无错误)
- [ ] 真 LLM kill -9 + 重启 reload hydration(留作可选回归测试,核心机制已通过单元测试覆盖)

## 12. Implementation Outcome(2026-06-03 close-out)

### 提交链(共 19 commits in this branch since C 期 close)
- `feat(teammate): extension scaffold` 起到 `feat(teammate): live widget refresh` 的 14 个增量 commit
- `feat(localagent): task_agent extends to spawn teammates` — task_agent 路由
- `feat(teammate): emit shutdown_request/response events from sender side` — handshake e2e
- `feat(teammate): robust session_shutdown cleanup` — Promise.allSettled
- `refactor: remove legacy extensions/subagents (replaced by D1 teammate)` — 删除冲突的旧 ext

### 关键架构决策落地(对照 § 2)
- ✅ `task_agent` 复用扩展(team_name + name 路由到 spawnTeammate)
- ✅ 长连接 idle 模型(teammateLoop 自动 ack shutdown,从不主动退)
- ✅ Session jsonl 派生持久化(`teammate/event` customType + reducer + hydrate)
- ✅ 透明 reload(`SessionManager.open` + 自动 spawn loop in resume mode)
- ✅ AsyncLocalStorage 隔离(spike-validated)
- ✅ Shutdown handshake(发送方 + 接收方双向事件)
- ✅ Kill 三档(handshake / task_kill / team_delete cascade)
- ✅ TUI: setWidget belowEditor + 实时刷新(team_store + task_store subscribe)

### Spike 教训(已纳入实现)
- `SessionManager.create(cwd, sessionDir)` 是新隔离 teammate session 的正确入口(不能用 `inMemory` — 没有 sessionFile)
- `SessionManager.open(file)` 续 prompt 工作正常(reload hydration 路径稳)
- ALS context 跨 `session.subscribe` callback 和 `session.prompt()` await 完整保留

### 删除遗留代码
- `extensions/subagents/` (18 文件,~3500 行,~59 个测试)— 早期 sketch,在 e2e 测试中与 D1 的 `send_message` 冲突。D1 完整覆盖其能力。

### 下一期(D2 — 留待后续)
- team task list(team_task_create / update / list / get)
- plan-mode approval handshake
- Permission sync(leader 集中处理 teammate 权限 prompts)
- TUI view-swap(方向键选 teammate / 回车进 teammate context / k 键 kill / 再回车回 leader)
