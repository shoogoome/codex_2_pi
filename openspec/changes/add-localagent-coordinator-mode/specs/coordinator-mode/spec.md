# Spec Delta

## Purpose

提供由用户显式选择、与模型及推理强度解耦的主会话协调工作模式，使需求沟通、任务派发和验收持续由主会话负责，同时不因职责分离减少主会话或 worker 的既有工具能力。

## ADDED Requirements

### Requirement: Explicit session-scoped mode selection
系统 SHALL 提供 `/coordinator on`、`/coordinator off` 和 `/coordinator status`，无参数等价于 status；提供 CLI 布尔参数 `--coordinator` / `--coordinator=false` 和环境变量 `PI_COORDINATOR_MODE`。环境变量 SHALL 接受不区分大小写的 1/true/on 与 0/false/off，空值等同未设置，无效值 SHALL 告警并按未设置处理。默认 SHALL 为关闭。新启动进程首次打开目标根会话时 SHALL 按显式 CLI、该分支保存的选择、环境变量、默认关闭的顺序解析；之后斜杠选择 SHALL 立即成为该会话的有效选择，并在 reload、压缩和分支恢复后保留。环境变量 SHALL 只作为启动默认值，不动态覆盖手动选择。

#### Scenario: Environment enables a new session
- **WHEN** 新会话没有保存状态或显式 CLI 参数，且 PI_COORDINATOR_MODE=on
- **THEN** 模式开启，status 展示有效状态和来源，不要求交互式终端

#### Scenario: Explicit CLI overrides restored state at process startup
- **WHEN** 新进程以 --coordinator=false 打开一个保存为开启的会话
- **THEN** 本次启动有效状态为关闭，该选择成为会话内当前状态

#### Scenario: Manual override survives reload
- **WHEN** 用户在环境变量或启动参数开启的会话执行 /coordinator off，随后 reload 或压缩
- **THEN** 模式保持关闭，不被原启动默认值重新打开

#### Scenario: New session and invalid input
- **WHEN** 用户切换到无保存状态的新会话，或提交未知子命令/无效环境值
- **THEN** 新会话独立解析启动默认值；无效命令不修改状态，无效环境值有可观察告警且不隐式开启

### Requirement: Role policy without tool restriction
开启时系统 SHALL 指导主会话负责澄清、计划、依赖、派发、纠偏、验收和沟通，并优先委派具体执行；小任务 SHALL 允许单个 worker 端到端完成，不以容量为并行数量目标。模式本身 MUST NOT 隐藏、停用或阻断主会话/worker 的既有工具，也 MUST NOT 新增文件写入门禁。主会话 SHALL 保留读取、评审和必要直接执行的能力；例外直接修改前 SHALL 避免与在途任务文件责任冲突。既有审批、Plan 和叶子 worker 不递归派生约束 SHALL 保持有效。

#### Scenario: Toggle preserves tools and inference configuration
- **WHEN** 用户开启或关闭协调模式
- **THEN** 原有活动工具和可调用声明不因模式切换减少，模型、provider、thinking 与 Fast 设置保持原值

#### Scenario: Simple task uses one worker
- **WHEN** 开启模式后用户提出一个单模块小修复
- **THEN** 协调策略允许只委派一个完整任务，不要求拆成多个 agent 或主会话执行每个细节

### Requirement: Compose with other workflows and worker identity
协调职责 SHALL 只作用于根主会话。worker 即使继承开启状态、环境变量或父历史，也 MUST 执行具体任务而非成为协调者。协调模式 SHALL 不受模型/effort 选择限制；与 Ultra 同时开启时 SHALL 形成单一、无矛盾的有效派发策略。Plan 或用户停用 task_agent 时 SHALL 显示暂停原因，不擅自激活工具或绕过只读约束；退出限制后 SHALL 恢复用户保存的选择。

#### Scenario: Non-Ultra explicit policy does not suppress coordinator
- **WHEN** 协调模式开启而 Ultra 未开启，或用户切换到其他 provider/model
- **THEN** 协调策略仍有效，不被“仅显式请求才委派”提示词抵消，也不改变推理配置

#### Scenario: Parent policy is not a worker role
- **WHEN** 主会话在协调模式中 fork 一个 LocalAgent
- **THEN** child 明确执行分配的工作，保留现有叶子限制，不运行协调者的恢复、告警或调度生命周期

#### Scenario: Pause and disable while workers exist
- **WHEN** 用户进入 Plan 或关闭协调模式时已有 worker 运行
- **THEN** Plan 继续执行已有只读边界，协调模式关闭本身不 kill worker、不回滚文件；已有报告和终态仍可交付，但不再注入新的协调职责或自动重派
