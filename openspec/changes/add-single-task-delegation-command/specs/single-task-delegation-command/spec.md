# Spec Delta

## Purpose

为用户提供一次性的结构化任务委派入口，让一个 LocalAgent 在后台完成限定工作，通过既有主子会话通信机制返回异常、修改内容及验证证据，同时让主会话及时回到可响应用户的状态，而不改变持续协调模式或现有权限边界。

## ADDED Requirements

### Requirement: Single invocation delegates one bounded task
系统 SHALL 提供随本包加载的 `/agent <任务>` 命令，默认为本次任务启动一个一次性 LocalAgent，而不是长期 teammate 或嵌套 agent。命令 MUST NOT 自动开启或关闭持续协调模式，后续无关用户请求 MUST NOT 因本次调用自动变成委派请求。

#### Scenario: Delegate with persistent coordination disabled
- **WHEN** 用户在持续协调模式关闭时运行 `/agent 修复 auth 超时`
- **THEN** 主会话组织并派发一个受管理的 LocalAgent，持续协调模式仍保持关闭

#### Scenario: Preserve an already enabled mode
- **WHEN** 用户在持续协调模式开启时运行 `/agent 调查 auth 超时`
- **THEN** 本次仍默认只派一个 worker，已有持续模式不被关闭或重设

### Requirement: Delegation instructions use native collapsed skill presentation
`/agent` SHALL 作为 `/skill:agent` 的快捷入口，保留任务参数并通过原生 Skill 加载和显示机制提供完整指令，交互界面默认折叠为 Skill 标识和独立任务文本，允许原生展开查看正文。模型 SHALL 仍收到完整指令，不以视觉折叠冒充 token 缩减。Skill SHALL 仅显式调用；主会话忙时入口 SHALL 使用 follow-up 排队，不打断当前执行、不等待空闲阻塞命令处理。Skill 未加载时 SHALL 清晰报错，不静默粘贴全文或派发。

#### Scenario: Invoke the shortcut with a task
- **WHEN** 用户输入 `/agent 调查 auth 超时`
- **THEN** 主会话收到 agent Skill 全文与原任务，界面默认显示可展开的 Skill 标识而非整篇用户提示词

#### Scenario: Skill is disabled by resource filtering
- **WHEN** agent Skill 没有被当前会话加载
- **THEN** 快捷入口告知检查 skills 配置并 reload，不启动模型委派也不绕过过滤读取文件

#### Scenario: Invoke while main model is busy
- **WHEN** 用户在主模型处理另一个请求期间调用 `/agent`
- **THEN** 原生 Skill 请求作为 follow-up 排队，当前处理不被 steering 打断

### Requirement: Dispatch includes an explicit outcome contract
主会话 SHALL 将目标、必要上下文、具体责任路径、非目标、验收条件、决策边界和交付要求明确告知 worker，并通过 `coordinator_task` 创建契约、通过 `coordinator_task_id` 绑定 `task_agent`。只读任务 SHALL 使用空写入责任集合。不得仅要求 worker 自行猜测主会话意图；存在影响授权或验收的关键歧义时 SHALL 先澄清而不启动。

#### Scenario: Read-only investigation
- **WHEN** 用户要求仅调查一个问题、不修改文件
- **THEN** 契约写入责任为空，worker 收到明确只读范围、所需证据和报告要求

#### Scenario: Missing task and insufficient context
- **WHEN** 用户仅输入 `/agent` 且当前上下文无法唯一确定任务
- **THEN** 主会话询问需要委派什么，不创建猜测的任务或 worker

### Requirement: Main session yields after dispatch
派发成功后主会话 SHALL 简短返回任务目标、范围、逻辑任务 ID 和执行 task ID，然后结束当前回合，不等待 worker 完成、不执行轮询或 sleep 等待循环。后续 SHALL 由已有关键事件和终态通知触发处理；有明确诊断需要或用户主动查询时允许一次状态检查。主会话 SHALL 保持可响应其他用户请求，不并行修改 worker 尚负责的文件。

#### Scenario: Worker still running
- **WHEN** `task_agent` 已返回后台执行 ID 而任务仍在运行
- **THEN** 主会话立即向用户确认已派发并结束回合，不接着调用状态工具等待完成

#### Scenario: User asks an unrelated question
- **WHEN** worker 在后台执行且用户发来其他问题
- **THEN** 主会话可正常回答，不要求用户等 worker 完成

### Requirement: Exceptions use bound bidirectional communication
worker SHALL 用 `localagent_report` 上报扩大范围、共享接口变化、阻塞、失败和交付，主会话 SHALL 用 `localagent_message` 向仍在运行的该 worker 发送定向指示。需要确认的纠偏 SHALL 由 worker 显式报告 `acknowledgement`，包含消息 ID、目标版本、采用方向和已有工作影响；入队回执 MUST NOT 当作理解完成或取消成功。常规进度 MUST NOT 要求主会话逐条响应。

#### Scenario: Worker needs a shared interface change
- **WHEN** worker 发现必须改变原约定共享接口
- **THEN** worker 先报告 `interface_change`，说明证据、影响、建议及所需决定，不擅自越界修改；如有安全独立工作可继续该部分

#### Scenario: Root changes direction
- **WHEN** 主会话更新任务目标并向运行中的 worker 发送新版本方向
- **THEN** worker 明确确认对应消息和版本，主会话不将 queued 或 entered 回执当作确认

### Requirement: Blocking produces a handoff rather than an idle worker
无法继续安全工作时 worker SHALL 先提交 `blocked` 报告，包含问题、证据、已尝试方案、建议、已修改文件、验证状态及剩余工作，然后安全结束，不无限等待主会话答复。后续继续 SHALL 使用同一逻辑任务的新执行实例，不能复活终态 worker；主会话 MUST NOT 无界自动重派。

#### Scenario: Decision required and no safe work remains
- **WHEN** worker 缺少关键用户决定且已无独立工作可继续
- **THEN** worker 报告完整交接并结束，主会话收到事件后处理决定，任务不被记为已验收

### Requirement: Delivery contains evidence and requires independent acceptance
worker SHALL 通过 `delivered` 提供 `modifiedFiles`、逐项 `acceptance`、实际命令与结果构成的 `verification`、`risks`，并在报告中明确关键行为变化、特殊处理、相对原计划的偏差及剩余工作；未执行验证 SHALL 说明原因，不伪造通过。主会话 SHALL 检查差异和证据后才通过 `coordinator_task` 提交验收证据；证据不足或交付有误时不得直接 accepted。

#### Scenario: Implementation complete but tests unavailable
- **WHEN** worker 已修改文件但测试环境不可用
- **THEN** 交付明确哪些验证未运行及原因，主会话保留待验收或要求补证，不向用户宣称测试通过

#### Scenario: Special compatibility workaround
- **WHEN** worker 在任务范围内采用了兼容性临时方案
- **THEN** 报告说明方案、原因、影响和剩余风险，主会话在验收时能识别该偏差

### Requirement: Delegation preserves tools permissions and ownership boundaries
命令 SHALL 遵守现有只读、探索、规划及审批限制，不得把规划授权转为 worker 实现授权；所需工具不可用、父会话不支持 fork 或派发被文件责任冲突拒绝时 SHALL 清晰说明失败和下一步，不偷偷启用工具、切换模式、改用其他执行机制或在主会话代做。启动失败 MUST NOT 被描述为已在后台执行。

#### Scenario: Tools unavailable
- **WHEN** 当前会话缺少或禁用了任务契约、派发或报告所需能力
- **THEN** 主会话说明缺失条件并停止派发，不自动开启能力或假称任务成功启动

#### Scenario: Exploration only
- **WHEN** 当前授权只允许探索、讨论或创建规划产物，用户尚未授权实现
- **THEN** 命令不得派发可修改项目代码的 worker，只能在既有授权范围内处理任务或提示需要新的实现授权

#### Scenario: Conflicting file ownership
- **WHEN** 派发被拒绝，因为另一个活跃 worker 已负责相同文件
- **THEN** 主会话说明冲突，不通过改写路径、取消绑定或主会话直接修改来绕过责任检查
