# 多 Agent 与长期 teammate

本包的当前多 Agent 路径由 `extensions/localagent`、`extensions/tasks`、`extensions/teammate` 和 `extensions/ultra` 共同提供，不再使用旧 RPC subagents 工具链。

## 两种运行方式

### 一次性 / 后台 Agent

调用 `task_agent`，不传 `team_name` 和 `name`：

- 默认前台运行；`run_in_background: true` 显式后台化，长任务也可自动转后台；
- 省略 `subagent_type` 时 fork 当前有效 Pi session 上下文；
- role 的 `tools` / `disallowedTools` 真实约束子会话；
- 后台终态通知自动包含有界最终回答，完整轨迹保存在 `output_file`；
- 不要轮询；终态会自动通知 leader。

### 长生命周期 teammate

同时传 `team_name` 与 `name`。成员拥有独立持久 session，可在多轮消息间 idle，并在根 session 恢复时重建。

常用工具：

- `team_create` / `team_delete`
- `send_message`
- `request_plan_approval` / `team_plan_approve`
- `team_task_create` / `team_task_update` / `team_task_list` / `team_task_get`

## Ultra workflow

对支持的 Codex Sol/Terra 模型启用 `/effort ultra` 后：

1. wire reasoning 使用 `max`；
2. 自动激活已注册的 `task_agent`；
3. 注入 proactive policy 与明确并行 workflow；
4. 有至少两个独立工作流时可在同一轮并行委派，leader 同时做独立工作；
5. 根据自动终态通知验证并综合结果。

简单任务不会被强制拆分。Plan 模式会暂停该 workflow 并保持 `task_agent` 禁用，退出 Plan 后再恢复。关闭 Ultra 时只撤销 Ultra 自己激活的 tool。

## 团队隔离与寻址

teammate 的规范身份是完整 `name@team`：

- teammate 输入裸名称时，只在自己的 team 内解析；
- leader 输入裸名称时，只有跨 team 唯一才解析，否则必须使用完整 agentId；
- `*` 只广播给发送者所在 team；leader 用 `*@team` 明确指定 team；
- team task custom tools 捕获 leader-realm store，并把成员读写限制在自己的 team；
- blocker 也不能跨 team 引用。

这些约束避免不同 team 的同名成员覆盖 mailbox receiver、消息串线或任务越权。

## 结果交付与消息恢复

- teammate 每轮最后一条 assistant 文本会自动以 `result` 通知注入 leader，无需成员额外调用 `send_message`；错误同样会主动唤醒 leader。
- peer message 按规范 recipient 持久化为 `message_sent`，成功处理后写 `message_ack`。
- resume 时只重放未 ACK 消息，并按原时间顺序投递；message id 用于幂等去重。
- 广播在持久层展开为每个实际 recipient，避免恢复时产生跨 team 或新增成员误投。
- leader DM 和 result payload 有上下文长度上限，完整子 session 仍保留原始内容。

交付语义是“处理成功后 ACK”的 at-least-once 恢复：极端进程崩溃可能重做尚未 ACK 的一轮，但不会静默丢失已持久化消息。

## 权限边界

teammate role 决定“看得见哪些工具”，运行时审批门禁决定“当前 turn 能否执行变更”：

- `write` / `edit` / `apply_patch` 等文件写工具；
- mutating `bash` / `task_bash`；
- MCP 工具（缺少可移植的读写元数据，保守按需审批）。

每个 turn 默认 fail-closed。成员必须调用 `request_plan_approval`，leader 用 `team_plan_approve` 批准后，门禁才对该 turn 开放；进入 idle 自动撤销。门禁通过进程级 AsyncLocalStorage 绑定真实 child prompt，即使 Pi 为子 session 使用独立模块 realm 也不会退化成仅提示词约束。

Plan 模式还会在根会话阻止 `task_agent` 和 mutating `task_bash`，并跨 realm 暂停所有既有 teammate 的 mutation gate、使此前批准失效，防止通过已驻留子 Agent 绕过只读边界。

## 安全恢复

spawn 时会把 role 定义的安全摘要写入 teammate identity。resume 时：

- 原 role 不存在：标记失败并通知 leader；
- role 的 prompt / tool policy 等定义发生变化：标记失败并通知 leader；
- 绝不回退到 `GENERAL_PURPOSE_AGENT tools:["*"]`。

旧 session 没有摘要时仍要求同名 role 存在；新建 teammate 会完整执行变更检测。

## 共享容量

localagent 与 teammate 共用根 session controller：

- `PI_AGENT_MAX_THREADS`：总驻留线程，默认 `6`，包含 leader；
- `PI_AGENT_MAX_CONCURRENT`：同时执行线程，默认 `4`，包含 leader。

因此默认最多 5 个驻留 child、3 个正在执行的 child。teammate idle 时释放 execution lease，但保留 resident lease；下一轮按 FIFO 重新获取 execution lease。完成、失败、取消、kill、shutdown 和根 session 切换都会释放或重置配额。

## 当前边界

- child 递归 spawn 仍关闭；
- 尚未提供选择性继承最近 N 轮上下文；
- 尚未提供跨所有 child 的根 session token / 费用硬预算。
