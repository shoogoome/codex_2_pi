# 多 Agent 与长期 teammate

本包的当前多 Agent 路径由 `extensions/localagent`、`extensions/tasks`、`extensions/teammate` 和 `extensions/ultra` 共同提供，不再使用旧 RPC subagents 工具链。

## 两种运行方式

### fork（默认）

调用 `task_agent`，不传 `team_name` 和 `name`，会从当前活动分支的有效上下文精简 fork 一个进程内 LocalAgent：

- 已压缩时，只复制最新摘要、`firstKeptEntryId` 起保留的消息和后续记录；未压缩时复制活动分支；
- 不重读父 JSONL，不复制其他分支、已总结的旧历史、费用/速度/监控快照和任务进度日志；
- 保留压缩系统提示词检查点、上下文编辑及必要引用，重建子会话父链；父历史文件不变；
- 子会话完成、失败或 kill 后释放 SDK 运行时引用；优化的是 fork 的历史复制，并非对任意活动上下文大小的内存保证；

- 固定后台运行，不接受 `run_in_background`；
- 精确继承启动时主会话的 provider、model 对象和 thinking level，不接受显式覆盖；
- Fast/UltraFast（包括关闭）在每次请求时读取主会话有效状态，随主会话切换，不依赖压缩历史或子 cwd 默认值；只安装 worker 专属钩子，不复制主会话全部扩展的启动流程；
- 要求主会话持久化；`--no-session` 下会明确报错；
- 可用 `cwd` 覆盖子会话工作目录；
- 叶子 worker 继承主会话活动工具，但始终移除 `task_agent` 和 `team_create`；额外的运行时工具门禁禁止创建 fork、teammate 或 team，身份检查不受上下文压缩影响；
- 终态通知自动把有界最终回答送回主会话，摘要式执行日志保存在 `output_file`，结构化交互详情独立有界保留；
- 不要轮询；终态会自动通知 leader。

该路径公开的参数只有：

```text
description  必填，3-5 个词的状态摘要
prompt       必填，fork 后要执行的具体任务
cwd          可选，覆盖工作目录
```

启动多个互相独立的任务时，应在同一条 assistant 消息中并行发出多个 `task_agent` 调用。调用返回后台 task id 后，不要立即轮询；继续主线程的独立工作并等待自动终态通知。

### LocalAgent 交互详情与运行中聊天

`tasks` / `localagent` 通过 `index.ts` 源码入口加载：预编译 ESM 的原生模块缓存可能在 `/reload` 后继续复用旧 UI。源入口同时让原生消息组件使用宿主依赖别名，保留与主会话一致的皮肤。退出详情后选择面板会自动失焦，主编辑器重新接收 Enter，避免输入 `/reload` 时意外重开任务。

1. `Ctrl+Y` 聚焦任务面板，方向键选择任务、`Enter` 进入详情。未聚焦时只展示运行任务；聚焦后还可选择“最近完成”的只读记录。
2. 详情复用活动 Pi 的原生消息/工具组件，实时显示本次委派开始后的自然语言、上游实际返回的可读思考、工具参数和运行中/最终结果。不会铺开继承的父历史，也不会把内部 fork 指令当用户消息。
3. 使用主界面配置的工具展开和思考显隐动作（默认 `Ctrl+O` / `Ctrl+T`）。`PgUp` / `PgDn` / `Home` / `End` 滚动；向上阅读时不会被新输出拉回底部，回到底部后恢复跟随。阅读状态与草稿按任务隔离。
4. 运行中可以直接输入自然语言，`Enter` 发送给当前子 agent；`q/Q` 不再退出，空提交不退出也不发请求。`Esc` 只返回主会话，不停止任务、不修改主草稿。详情不执行 `/new`、模型切换等斜杠控制命令。
5. 消息会区分 submitting、queued、entered、handled、failed、cancelled：排队不代表模型已经阅读，entered 只表示已进入子会话。干预在当前 assistant 回合及其工具处理后的安全边界进入，不立即终止正在执行的命令；真正停止请使用 `task_kill`。
6. 自然完成会等待已接收消息的执行，之后仍只发一次终态通知并释放 session/容量，不为等待用户追问而 idle。完成后的详情立即只读，不接受新消息，不创建新的 agent；提交撞上关闭时明确拒绝并保留文本。
7. 展示副本只保存在当前根会话内存中，默认每任务 8 MiB、总计 64 MiB、最多 20 条完成记录。超限优先淘汰旧的未打开完成记录，再裁剪展示负载并显示提示；打开详情不阻止预算裁剪，也不会延长 agent 生命周期。关闭/切换根会话会清理这些副本，不支持跨 Pi 重启恢复。
8. 自定义 renderer 不兼容或无法在释放 worker 后安全重建时，明确回退到通用参数/结果展示；旧任务没有结构化记录时显示只读“旧日志视图”。无 TUI 时任务工具和终态通知照常工作，不启动终端组件。

### 长生命周期 teammate

同时传 `team_name` 与 `name`（需先 `team_create`）。此时可用 `subagent_type` 选择 role，默认 `general-purpose`。两个参数必须成对出现——只传其一会明确报错，而不是静默回退到 fork。

成员拥有独立持久 session，可在多轮消息间 idle，并在根 session 恢复时重建。

常用工具：

- `team_create` / `team_delete`
- `send_message`
- `request_plan_approval` / `team_plan_approve`
- `team_task_create` / `team_task_update` / `team_task_list` / `team_task_get`

## 主会话协调模式

可用 `/coordinator on|off|status`、CLI `--coordinator` / `--coordinator=false`、环境变量 `PI_COORDINATOR_MODE` 手动选择，默认关闭，与模型/effort 无关。主会话负责沟通、逻辑任务、派发、纠偏和验收，具体执行优先交给一次性 LocalAgent；保留所有既有工具，不自动激活被停用的 task_agent。协调模式与 Ultra 同开时使用统一职责策略，Plan/审批/叶子边界不变。

`coordinator_task` 创建/查询/更新任务；`task_agent(coordinator_task_id=...)` 绑定执行；`localagent_message` 定向 steering；`localagent_report` 由真实 worker 绑定身份报告。逻辑任务跨执行实例保存交接，交付不是验收，真正阻塞时结束释放，不变成长驻 teammate。共享目录只做派发责任协调，不提供写入沙箱；有在途受管理执行/预留时暂缓会话树导航，不自动 kill。完整开关优先级、消息状态、预算和恢复限制见 [coordinator.md](coordinator.md)。

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

- `PI_AGENT_MAX_THREADS`：总驻留线程，默认 `9`，包含 leader；
- `PI_AGENT_MAX_CONCURRENT`：同时执行线程，默认 `9`，包含 leader。

因此默认最多 8 个驻留 child、8 个正在执行的 child。驻留名额满时新建报错，执行名额满时按 FIFO 排队；并发总数自动限制为不超过驻留总数。例如设置 `PI_AGENT_MAX_THREADS=13 PI_AGENT_MAX_CONCURRENT=9` 可驻留 12 个 child、同时执行 8 个。环境变量在启动时读取，无效或非正数按原解析规则回退到默认值，不支持运行中热更新。容量是上限，不是必须派发的数量。teammate idle 时释放 execution lease，但保留 resident lease；下一轮按 FIFO 重新获取 execution lease。完成、失败、取消、kill、shutdown 和根 session 切换都会释放或重置配额。

## 当前边界

- child 递归 spawn 仍关闭；
- 尚未提供选择性继承最近 N 轮上下文；
- 尚未提供跨所有 child 的根 session token / 费用硬预算。
