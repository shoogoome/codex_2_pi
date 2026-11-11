---
name: agent
description: "将本次任务结构化委派给一个后台 LocalAgent，主会话保持可响应。通过 /agent 或 /skill:agent 显式调用。"
disable-model-invocation: true
---

# 本次单次委派

你是主会话。将本 Skill 指令之后附带的用户请求作为本次任务，委派给默认一个一次性 LocalAgent；本次调用不是持续模式开关，不影响后续无关请求。保留当前 `/coordinator` 状态，不自动开启或关闭它。任务参数由原生 Skill 调用附在指令之后，不使用模板参数占位符。

## 1. 主会话：确认任务与授权

- 结合当前上下文理解附带的任务请求；缺少参数且无法唯一确定任务，先问用户需要委派什么。目标、范围或验收存在关键歧义时，先澄清，不猜测派发。
- 本命令只授权本次委派，不扩大任务本身的权限。遵守现有只读、探索、规划和审批边界；只有规划授权时不得派发实现任务，不能借 worker 绕过审批。只读任务明确禁止修改，并使用 `writePaths: []`。
- 仅做组织契约所需的最小只读定位，不先在主会话把任务做完。保留已有未提交改动，检查当前任务的文件责任，主会话也不能抢改活跃 worker 负责的文件。
- 确认 `coordinator_task`、`task_agent`、`localagent_message`、`localagent_report` 等所需能力可用，父会话须持久化以支持 fork。工具缺失/被禁用或条件不满足时，说明限制与下一步并停止派发，不擅自激活工具或切换模式。

## 2. 主会话：先建契约，再派发

先调用 `coordinator_task`，`action: "create"`，contract 明确填写：

- `objective`：具体目标和预期结果。
- `acceptance`：逐项可检查的验收标准，包括应实际执行的验证。
- `nonGoals`：明确不做什么，不顺带重构或扩大范围。
- `writePaths`：具体文件或目录，不用 glob；只读为 `[]`。共享目录按单写者责任协作，这不是文件沙箱。
- `dependencies`：仅在确有上游逻辑任务时填写，上游须已由主会话验收。

收到成功结果后，保存逻辑任务 ID 及目标版本，再调用一次 `task_agent`：

- `description`：简短任务名。
- `coordinator_task_id`：刚创建的逻辑任务 ID。即使持续模式关闭也必须显式绑定，否则 worker 的报告没有本次任务的 runtime 身份。
- `prompt`：按下一节组织具体 assignment；契约是权威目标，不得在 prompt 中另设冲突的验收条件。
- `cwd`：只有确有需要才显式填写，必须与契约所属工作目录一致。

不要传 `team_name`、`name` 来创建长期 teammate，也不要传不存在的 `model` 或 `run_in_background` 参数；fork 本来就在后台运行。不要把整份主会话流程复制给 worker，避免让它再次派发。

创建契约或启动失败时如实报告失败。文件责任冲突时说明冲突，不通过改写路径、取消绑定或主会话直接修改来绕过检查。不静默降级到无绑定 fork、其他执行机制或主会话代做；不能把创建了契约说成已成功启动 worker。

## 3. 只发给 worker 的 assignment

将以下内容填成针对本次任务的具体指令，不留空泛占位符：

1. **目标**：要解决的问题和完成效果。
2. **上下文**：已确认事实、相关文件入口、约定和必要的前次交接；不要仅说“按上面的做”。
3. **范围与禁止事项**：责任路径、非目标、现有未提交改动和授权限制。你是叶子 worker，使用自身工具完成工作，不能创建 fork、teammate 或 team。
4. **执行建议**：必要步骤与已知陷阱，允许在授权范围内合理调整方法；范围外修改、新增依赖、共享接口变化必须先报告，不先做后报。
5. **验收**：逐项完成条件、应运行的测试/类型检查或其他验证；实际未运行的明确原因，不能伪造通过。
6. **沟通与决策边界**：使用下面的事件协议，不自行代替主会话批准扩围或验收。
7. **交付**：按下面的 delivered 内容返回，最后简短总结并结束执行。

### Worker 事件协议

使用 `localagent_report({ event_id, event, payload })`，来源由 runtime 绑定，不伪造任务身份；payload 带当前 `targetVersion`。每个新事件使用新的 event_id，同一事件重试复用 event_id 和完全相同内容，避免重复推进状态。

- **`scope_change`**：发现需要扩大修改范围或新增依赖。报告 problem、evidence、impact、recommendation、所需决定。范围外部分先不做，仍有安全独立工作可以继续。
- **`interface_change`**：发现需要更改共享接口、参数、数据格式或配置兼容性。同样说明证据、影响、建议和所需决定，未经决定不擅自实施变更。
- **`acknowledgement`**：收到主会话纠偏后，明确报告 `messageId`、`targetVersion`、`direction`（采用的新方向）、`impact`（对已有工作的影响）。queued/entered/handled 只是投递状态，不代表你已理解。
- **`blocked`**：缺权限、关键决定或其他条件，且已无安全工作可继续时，报告 `problem`、`evidence`、`tried`、`recommendation`、`modifiedFiles`、`verification`、`remaining`；先安全交接，然后自然结束，不无限 idle 等主会话答复。
- **`failed`**：说明失败证据、已改文件、验证状态和剩余现场，不隐瞒副作用。
- **`checkpoint`**：普通进度不要求主会话回复；只有需要主会话行动的关键成果才设置 `requiresAction: true`，不逐条汇报工具日志。
- **`delivered`**：完成后提交下列结构化证据。交付不等于主会话验收，不能自行 accepted。

### Worker 交付内容

`delivered.payload` 至少包含：

- `targetVersion`：本次确认的当前目标版本。
- `modifiedFiles`：实际修改的每个文件及关键行为变化；只读任务返回空数组，并在 acceptance 中给出调查结论与证据位置。
- `acceptance`：逐项验收条件、完成状态及证据，不以笼统“已完成”代替。
- `verification`：实际执行的命令、结果；未执行或失败的验证明确原因。
- `specialHandling`：特殊处理、临时/兼容方案及理由，无则 `[]`。
- `deviations`：相对原计划的偏差和影响，无则 `[]`。
- `risks`：剩余风险，无则 `[]`。
- `remaining`：未完成工作或需要主会话决定的事项，无则 `[]`。

报告超过工具限制时保留聚焦摘要并引用已保存的输出，不灌入完整日志。若报告返回 saved=true 但带 notificationError，不假称主会话已收到；可按同一 event_id 重试，不无限重试或等待。

## 4. 主会话：派发成功立即释放当前回合

`task_agent` 成功返回后台执行 task ID 后，简短回复用户：已委派的目标、责任范围、逻辑任务 ID、执行 task ID，以及关键异常/完成会自动回传。然后立即结束当前回合，让用户继续提问。

不要为了等结果继续调用工具；不等待 worker 完成，不循环调用 `task_status` / `task_list` / 消息回执查询，不 sleep 或空转。仅用户主动查询或有明确诊断需要时做一次必要状态检查。保持可响应其他用户请求，但不并行修改 worker 尚负责的文件。命令不要求持续模式开启，也不承诺关闭模式时有常驻诊断告警。

## 5. 主会话：收到后续事件再处理

这些规则只用于本次逻辑任务的后续通知，不将后续无关用户请求自动委派：

- 根据事件读取必要的契约/交接，不重复调查已提供的完整证据。需要用户决定时说明影响并询问；可在已有授权内决定的自行处理。
- 对仍在运行的 worker，用 `localagent_message`，`action: "send"`、执行 `task_id`、`text` 定向沟通。改变目标、范围或验收时，先用 `coordinator_task update` 记录新契约与决定，带最新 `expected_revision`；冲突时重新读取。再以新 `target_version` 发消息，并要求 worker 显式 acknowledgement，不能把 queued/entered/handled 当作理解完成。
- 普通消息不等于取消；要求立即停止时使用 `task_kill`，不要宣称排队的停止消息已中断工具。已有文件修改和外部副作用不会自动回滚。
- blocked 报告后须等原执行真实结算释放，再在决定明确后按同一逻辑任务、新执行实例继续；不复活终态 worker，不无界自动重派，遵守既有尝试预算。未获决定不得扩围。
- 收到 delivered/终态后检查实际差异、逐项验收和验证证据。证据不足不得宣称通过；补证或记录原因后有界返工。证据充分时才用 `coordinator_task update`，最新 `expected_revision` 与 `patch: { status: "accepted", reviewEvidence: "实际审查结论与证据" }` 验收。
- 最终向用户简短说明改了什么、验证结果、特殊处理/偏差和风险/剩余工作；不把 worker 正常结束当作目标已验收。
