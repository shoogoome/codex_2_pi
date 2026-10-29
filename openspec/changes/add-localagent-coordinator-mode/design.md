# Design

## Context

动机与范围见 `proposal.md`，可观察契约见四份 delta specs。本变更涉及命令/会话状态、fork 创建、任务通信、通知、Ultra 提示词与资源结算，符合跨模块、生命周期和安全复杂度条件，因此必须提供设计。

已只读核对的当前事实：

- `extensions/localagent/tools/taskAgent.ts` 将 `pi.getActiveTools()` 作为 child 工具池，不带 team 参数时 fork，同传 team_name/name 时走既有 teammate。模型/provider/thinking 由 `inheritParentRuntime` 继承；默认 fork 不接受角色和模型覆盖。
- `spawnLocalAgent.ts` 使用进程内 Pi SDK：先取得共享容量，创建内存 fork，再注册一次性执行；`interaction.run()` 的全部执行 promise 结算后才有终态。`agent_end` 不是最终结算信号。终态通知与清理已通过幂等状态处理，不能再造第二套 owner。
- `interactionController.ts` 和 `tasks/agentConversations.ts` 已有同一执行的 FIFO 提交、queued/entered/handled/failed/cancelled 状态，以及与结束竞争的安全受理边界。`submit()` 目前只返回 accepted/error，未返回消息 ID，也没有可验证的模型 acknowledgement。详情展示 store 有内存预算、会淘汰，不能充当可靠任务账本。
- `workerRuntime.ts` 只装 Fast、输入关闭及叶子门禁，`workerIdentity.ts` 的真实运行身份不依赖历史。现有禁止递归 spawn 是原边界，本变更不撤销，也不新增业务工具限制。
- `tasks/notifications.ts` 负责原有单次终态通知；`pi.sendMessage` 默认投递可唤醒模型，显式 nextTurn 与 triggerTurn 组合不能被误认为立即唤醒。`TasksHandle` 和 `shared/sessionHandle.ts` 通过共享 EventBus 解决 jiti realm 隔离，不能用扩展模块单例通信。
- `ultra/index.ts` 在 before_agent_start 注入 proactive/explicit 两态和工作流，且有自己激活 task_agent 的行为；独立添加协调提示词会与 explicit 文字冲突。Plan 已控制派生和变更权限，不能通过协调消息绕过。
- `tasks/agentCapacity.ts` 默认总数 6/4，环境变量已存在并包含 leader；修改默认即可，不能重复设计新的一组 worker 配额变量。
- 根包使用 `pi.extensions: ["./extensions"]` 目录发现；tasks/localagent 固定源码入口以避免 reload 的原生 ESM 缓存。新包应同样保持源码加载，而不是引入旧 RPC 后端。
- 已参考活动 Pi 的完整 extensions/sdk 文档及 todo、prompt-customizer、SDK extensions 示例。项目声明的开发 API 与实际 CLI 版本有差异，结构化提示词优先，兼容回退只保留一个自有块；实际验收必须覆盖活动 CLI，不能只依赖静态 fake。

## Goals / Non-Goals

**Goals:**

- 把模式选择、逻辑任务账本和一次性执行分层；worker 被释放不丢任务责任与交接。
- 运行时验证消息归属、版本与派发责任，不依靠模型自报身份；但角色分工不变成工具限制。
- 复用现有执行 owner、steering 和终态路径，避免两套队列/终态/容量计数。
- 命令、结构化查询和通知在无 TUI 时同样可用；UI 只作状态投影。

**Non-Goals:**

- 不建设自主 scheduler daemon，不让代码自动决定用户需求、验收或无限重试；主模型仍是编排决策者。
- 不保证共享目录物理隔离或拦截所有越界写入，不引入 worktree、操作系统文件锁、命令沙箱或工具白名单。
- 不克隆主会话全部扩展生命周期，不改推理继承规则，不为 worker 提供长期 idle、终态复活或跨重启执行恢复。
- 不承诺全局 token/费用硬预算、持久消息 exactly-once、事务性外部副作用、自动 git 提交/回滚。

## Decisions

### 1. 独立 coordinator 扩展与会话选择

新增 `extensions/coordinator/`：`index.ts` 只负责命令、flag、生命周期和工具注册；`mode.ts`/`prompt.ts` 放纯函数；`handle.ts` 用 shared session handle 发布根会话 controller。包入口保持 `index.ts`，在 `scripts/build-extensions.mjs` 的源码 SKIP 中加入 coordinator；根目录现有发现配置无需改格式。

接口：

- `/coordinator` 与 `/coordinator status` 只读展示 desired/effective、来源及暂停原因；`on`/`off` 修改当前根会话选择，不触发模型工作、不 kill child。
- CLI 注册布尔 `coordinator`；必须辨别未传与显式 false，不能让 flag 的默认 false 吞掉环境默认值。支持 `--coordinator` 和 `--coordinator=false`。实际 CLI 验收发现 Pi 1.4.0 的 applyExtensionFlagValues 把任何布尔 flag 都归一为 true（丢失 =false），因此在扩展内增加仅解析自身 argv 拼写的兼容纯函数，优先恢复显式 =false；无原始 CLI 参数的 SDK 调用仍使用 getFlag，不修改 SDK，也不扫描其他 flag。
- `PI_COORDINATOR_MODE` 只读启动默认值，真/假文本按规格解析；无效值告警但不导致会话启动失败。
- 新进程首次打开目标会话：显式 CLI > 当前分支保存选择 > 环境值 > false。使用版本化 `coordinator/state` custom entry 保存最终选择与来源；之后命令为权威，reload/compact/tree 从分支重建，不重复应用原 CLI。CLI 的初次覆盖需要在初始化 owner 中消费一次，运行时替换不能重新当进程启动。
- 新建或切换其他根会话独立解析该会话选择；不把上一个会话内存值当默认。保存的是 desired；effective 为 active、off、paused-plan、paused-task-agent-inactive/unavailable、paused-session-unpersisted。状态来源及原因在无 UI 时也能查询。

拒绝方案：仅提示词或环境变量热读取会在 reload/恢复/child 继承时漂移；更改全局 settings 会把会话选择泄漏到无关会话。

### 2. 一份有效工作策略，不修改工具 loadout

增加小型共享策略组合器（建议 `extensions/shared/agentWorkflowPolicy.ts`），coordinator 与 Ultra 在 before_agent_start 都从真实运行身份、根 coordinator handle、Ultra 有效状态和 Plan/task_agent 可用性计算相同结果，规范化各自拥有的标记块。现有 Ultra 导出 helper 保留兼容包装，不大规模重构无关 effort 代码。

Plan 的运行状态以共享 `getAgentMutationPause().paused` 为准；`exit_plan_mode` 可能仅已注册/激活，不能据此判断正在规划。优先顺序：worker 执行身份 > Plan/审批约束 > 已开启协调职责 > 原 Ultra proactive/默认 explicit 策略。协调模式与 Ultra 同开时只保留一套职责/派发指令，Ultra 的 wire reasoning 保持原行为；协调关闭恢复原策略。协调开启时 Ultra 不应因自己的激活逻辑把用户停用的 task_agent 自动打开，显示暂停即可；协调关闭时保留 Ultra 原激活/清理契约。

协调模式不调用 setActiveTools，不使用 hiddenDeclarations，不注册新的业务 tool_call 拦截。新增协调工具的正常注册不是移除既有工具。task_agent 被用户停用、不可用或 Plan 禁用时不擅自激活；不能因为模式需要 worker 就突破批准边界。

worker 的运行时身份始终压过 fork 历史中的主会话职责。配置扩展只在根会话初始化账本/定时器；worker 专属 hook 清理或替换协调者提示块并追加执行契约，不能靠主历史里的字符串猜角色。旧 leaf guard 仍保留。主会话需要直接操作时先处理文件责任交接，但文件工具保持可用。

拒绝方案：按角色缩减工具违反用户约束且会导致 child 继承不到写工具；单独追加 system prompt 会被 Ultra explicit 块覆盖，或使 worker 也等待派发。

### 3. 逻辑任务账本与执行实例分离

建议 `taskLedger.ts`、`taskContract.ts`、`pathOwnership.ts`、`persistence.ts`、`tools/coordinatorTask.ts`：

- `coordinator_task` 使用 action=create/get/list/update；create 必须提供 objective、acceptance、nonGoals、writePaths（只读任务显式空数组），dependencies 默认空。update 使用 expectedRevision 做乐观并发校验；accepted 只能由根主会话更新，必须有 reviewEvidence；预算调整需要 decisionReason。
- 任务包含 id、revision、targetVersion、status、dependencies、writePaths、decisions、budgets、attempts、handoff、verification、reviewEvidence。每个 attempt 包含唯一 attemptId、executionTaskId、generation、assigned/acknowledgedVersion、启动/结束信息与报告，不能以模型自报 ID 代替运行绑定。
- `task_agent` 新增可选 `coordinator_task_id`，不使用已被拒绝的 legacy isolation/model 参数。协调模式有效时默认 fork 必须有完整任务绑定；模式关闭且不传绑定时完全保留原接口。teammate 路由不承担新逻辑任务，传绑定则明确错误而不静默忽略。
- 一份契约覆盖完整可验收成果；执行 prompt 包含最新契约和有界交接摘要。系统不把模糊目标自动拆成 N 个任务，主会话决定 DAG、并发和时机。

状态流：

```text
pending --> running --> awaiting_review --> accepted
   ^           |               |
   |           +--> blocked ---+
   |           +--> failed ----+
   +----------- rework / decision

cancelled: only after the execution has actually settled
```

blocked/delivered/failed 报告先记 attempt 的报告意图，不提前释放责任或把尚在运行的执行当终态。初始派发视为领取并确认当时目标；后续目标变化必须显式 ack。报告意图按当前版本的有效事件顺序更新：若阻塞后及时收到决策并确认继续，后续 delivered 可替代先前 blocked；旧版本和重复事件不能改写该意图。最终状态由唯一执行结算回调决定：kill -> cancelled；异常或 failed 意图 -> failed；blocked 意图或尚未确认当前目标版本 -> blocked（后者原因 outdated-direction）；其余正常结束 -> awaiting_review。交付另行记录 reportVersion，handoff 标注 handoffVersion/尝试来源；ack 新目标不刷新旧交付版本。旧版本结果只归档到对应 attempt，不作为新目标的交付。空 verification 字符串/数组/对象或无详情状态不算验证证据，保持 evidenceMissing 标记。无结构化交付则记录 evidenceMissing。需要返工/续派由根更新 pending，不允许有活跃执行时强改 accepted 或启动第二次尝试。

### 4. 单写者是原子派发责任，不是工具门禁

writePaths 采用 cwd 解析后的规范绝对路径，不支持 glob，允许文件和目录；路径先处理 realpath 的现有祖先以识别常见符号链接别名。目录/文件祖先相交算冲突，纯只读任务不占写入责任。该检查无法消除运行中符号链接改变等 TOCTOU，不能宣称是安全沙箱。

在根 controller 的同一同步事务内检查依赖已 accepted、任务 revision/targetVersion、attempt 预算和活跃实例，并预留文件责任与 launching token，防止并行 task_agent 都看到未占用。通过该 token 启动现有 LocalAgent；创建失败回滚预留且不记已启动 attempt，注册真实执行后提交 attempt。执行等待期间、blocked 报告后和取消请求发出后均保持责任，直到真实结算/清理确认。

依赖使用稳定逻辑任务 ID，create/update 校验存在性、不能自引用或形成环；依赖只认 accepted，不认 worker completed。writePaths 变更若影响活跃责任必须等执行结算后进行。只读 reviewer 与 writer 可并行，但 reviewer 不应暗中写。

拒绝方案：仅在 prompt 写“别冲突”不足以避免同时派发；为 edit/bash 新增路径拦截又违反不屏蔽工具的约束。这里限制的是受管理派发，不是文件工具执行能力。

### 5. 根绑定的双向通信，复用唯一输入控制器

建议 `tools/localagentMessage.ts`、`tools/localagentReport.ts`、`messageRegistry.ts` 和 `workerBridge.ts`：

- `localagent_message` 接受 task_id、text、可选重试 message_id；受管理任务的 target_version 从账本核对。响应包含 messageId、accepted、deliveryStatus，支持 action=get 查询同一 messageId。不使用 teammate 的 send_message 冒充 LocalAgent 通道。
- 扩展 ConversationControl.submit 的可选元数据与结果，返回真实 submissionId；UI 不传元数据也保持原逻辑。已受理消息写入独立有界 registry/任务摘要，不能依赖会被裁剪的 UI 展示副本。用户 UI 与主模型提交共享同一 FIFO、admission gate 和 runs 集合。
- 重试 messageId 按根 generation + 执行 task ID 去重；不同消息即使同文也不合并。投递状态沿用原 submitting/queued/entered/handled/failed/cancelled；模型语义确认独立存 acknowledgedVersion/ackText，不重命名 handled。
- `localagent_report` 接受 event、event_id、payload；ack 必须包含真实 messageId 和 targetVersion。任务/发送者 ID 不由模型决定。root 注册清晰的未绑定错误实现；child 在 worker 专属 runtime 中装同名、绑定真实 attempt 的实现。根与 worker 既有工具不被过滤，不为了报告启动全套主会话 lifecycle。
- spawn 在创建 worker services 之前建立 root-bound bridge 与预留 attempt token，创建 task ID 后绑定 executionTaskId。bridge 闭包持有根 handle、generation、真实 attempt、isOpen；经现有共享句柄把任务实例和回调传给 fork，不期待 child EventBus 自动等于父 EventBus，不依赖模块全局。
- 工作线程报告仅能写自己 attempt 的事实和意图；不能接受交付、接管其他任务、更新任意预算或创建 child。worker 若调用根管理操作返回身份不适用，而非更改工具曝光。

目标改变时递增 targetVersion，保留 attempt 已领取版本；任务标记 awaitingDirectionAck。主会话选择纠偏或 kill，不自动广播所有用户消息。新版本 ack 必须对应实际接收的纠偏；旧版本报告只留审计，不能覆盖新版本验收。尚有旧执行时不再 fork 新执行，避免两个方向同时写。

### 6. 事件通知和交付沿用原终态 owner

非终态报告使用 eventId 幂等追加到账本，仅需要主会话行动的事件触发有界 `coordinator/event` 消息。ack 更新投递状态及任务方向，通常不单独唤醒；普通工具活动仅更新面板和最近活动时间。checkpoint 显式标记需要协调行动，不让每个小步骤都升级通知。

worker 调用 delivered 只保存交付；blocked 唤醒主会话并要求 worker 完成交接自然结束。不能安全继续时不 idle 等待；尚有独立工作则先发 scope/interface 事件而非 blocked。主会话在窗口内的回复可进入现有 steering，结束后消息必须拒绝并通过新 attempt 续派。

在 `spawnLocalAgent.ts` 与 kill 的现有唯一终态路径加入可选 lifecycle bridge：结算更新账本，原 `notifyTaskTerminal` 的 extra 带 logicalTaskId、attemptId、targetVersion、handoff/evidenceMissing。delivered 不额外发完成唤醒，避免两次 final；blocked 已通知的终态仍按原路径可观察，但不把它再当一份新的待决问题。终态未报告也必须正常送达。

报告持久化与通知失败要分开：事实已保存则通知失败可重试同一 eventId，不能重新运行工作或重复改变状态；返回结构化 saved/notificationError，并在状态查询中可见。内容限长且明确截断，完整交接从任务读取，不全量复制 child transcript。保留原任务清理 finally：账本、通知、UI 失败均不能阻止 abort/dispose/lease 释放。只能承诺运行时去重与可观察失败，不宣称进程崩溃下 exactly-once。

### 7. 可恢复的账本与有界上下文

版本化 `coordinator/state`、`coordinator/task` custom entries 记录模式与按任务完整快照（schemaVersion、revision）；在 session_start/tree/compact 从当前 branch 重建，通过显式状态句柄供各 realm 访问。状态条目不直接成为模型消息；每轮仅注入模式与任务的有界摘要，具体 handoff 通过 get 读取。磁盘是会话已有存储，不另写长期 memory 文件。

不得依赖被摘要丢弃的提示词恢复模式；custom 状态快照应不受普通 transcript 压缩影响，集成测试验证压缩后 branch 回放。未知 schemaVersion 明确报不支持，不静默把未知账本重置为空并重复工作。

用户确认：session_tree 不会触发 LocalAgent shutdown，因此在 session_before_tree 检查受管理活跃 attempt 和 launching 预留，有在途任务就返回 cancel 并提示等待/显式停止，不自动 kill 或隐藏工具；原执行真正结算并释放责任后才能导航。没有在途任务时按分支重建账本，不引入跨分支后台责任 registry。

初始化时对照当前根 live task store：恢复的 running 若没有匹配 generation 的真实执行，记 blocked/interrupted、保留现场并解除已不存在的执行责任；不重建 worker、不重放危险副作用。根替换/关闭使 generation 失效并拒绝旧 bridge；reload 不能从旧运行回调污染新账本。压缩不是根替换，重建快照时必须保留正在启动的预留。实际 SDK 的 shutdown 按扩展顺序执行，因此 tasks 在清空 store 前需显式取消仍运行的 LocalAgent，不能依赖 localagent 的较晚 shutdown 回调，否则会先丢失运行时句柄；正常已结算的执行不重复取消。关闭模式不销毁账本和现有报告通道。

逻辑任务的目标/最新交接/验收证据持久保留；大日志只保留路径，文本和事件字段有集中长度上限及显式截断标记，读接口分页，历史 attempt 摘要与完整执行日志分离，防止每次 prompt 展开全部历史。

### 8. 预算是防失控边界，告警不是自动 kill

逻辑任务默认 maxAttempts=3、stallAfterMs=300000、attemptWarnAfterMs=1800000，均可由 coordinator_task 在合法正数范围覆盖。三项是本提案的保守初版默认值，不是已存在的运行时行为；只在任务契约配置，不新增一组零散环境变量。

maxAttempts 在成功注册执行后计数，包含阻塞、失败和返工尝试；配置/配额/初始化失败不消费。上限已到时新受管理派发拒绝，主会话必须记录理由调整预算或重新讨论方案，代码不自动重试。

根 controller 管理一个 session-scoped unref 定时器，读取已有执行活动（流式模型事件与工具 start/update/end），只对有活跃 attempt 且模式开启的任务诊断。无活动 5 分钟告警每个静默区间一次，单次时长 30 分钟告警每个 attempt 一次；同一检查同时命中则合并。提供当前工具、工具时长和最后活动，不从 token 无变化推断卡死。恢复活动后可开启新静默区间；禁用模式/Plan 暂停新告警，根 shutdown 清理定时器。该过程不请求模型查询任务，不自动 kill，不替代用户的审批和停止权。

拒绝方案：频繁 task_status 轮询浪费上下文和主会话时间；硬 timeout 中断工具可能留下更差现场；全局 token 预算需更完整的计费归集，本版不实现。

### 9. 容量改动独立且向后兼容

`DEFAULT_AGENT_MAX_THREADS` 与 `DEFAULT_AGENT_MAX_CONCURRENT` 均设为 9，保持 `positiveInteger` 现有解析语义与并发取 min 的方式，不顺手改解析容错。现有环境变量名称、包含 leader 的含义与启动读取时机不变；配额依旧由 tasks canonical controller 管理，coordinator 不另扣一份 resident/execution lease。

针对默认值新增 8 个成功/第 9 个驻留失败测试，保留显式 maxThreads=6/maxConcurrent=4 的三 child FIFO 用例作为自定义配置测试；启动失败、取消、reset、late release 测试继续成立。teammate idle/resident 语义保持原样。

## Risks / Trade-offs

- [共享目录仍可越界写或被外部进程修改] → 原子派发责任、启动核对现场、接口变化上报、差异验收；明确不是文件隔离，后续若需要强隔离另提 worktree 变更。
- [模式 prompt 与 Ultra/worker 历史冲突] → 共用幂等策略组合器、真实运行身份优先，测试两种 hook 顺序及压缩后行为。
- [根会话持久状态与执行现场短暂不同步] → launching 预留 token、revision/CAS、终态桥接幂等、恢复时 interrupted；不自动重放副作用。
- [kill 无法撤销已执行工具副作用] → 取消确认与回滚承诺分离，责任直到真实结算才释放；危险操作仍走既有审批。
- [报告/通知链出错泄漏 session 或产生双终态] → 接入既有唯一 owner、独立 finally，错误注入测试覆盖持久化和通知失败。
- [默认 8 并发提高内存和供应商限流压力] → 环境覆盖保持可用、不强制用满，任务拆分按独立性，保留原重试/错误处理但不承诺自动吞掉限流。
- [软角色约定可能被模型偏离] → 可观察任务、交接、实际差异和验收闭环；不能声称职责由安全机制强制执行，也不借此屏蔽工具。

## Migration Plan

1. 先以独立测试调整容量默认 9/9 与文档，环境变量不迁移；该行为对所有模式生效。
2. 新增 coordinator 源码包及纯函数、账本/状态和命令注册，默认 off；旧会话无 entry 时不迁移文件、不自动派发。
3. 接入可选 task_agent 绑定、worker bridge、消息/报告和原终态通知，验证无绑定旧路径与现有 UI steering 不回归。
4. 接入统一策略、恢复与告警，更新文档/能力索引，执行针对性、全量测试与 typecheck，并在活动 CLI 手工验收 reload、8 child 和交互纠偏。
5. 回滚可 `/coordinator off` 或移除 coordinator 包/相关接线；旧 custom entries 作为不执行的数据保留，不恢复 worker、不清理用户文件。若回滚容量则恢复 6/4 默认，已有环境覆盖仍有效。
