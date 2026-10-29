# Spec Delta

## Purpose

为主模型与运行中的一次性 LocalAgent 提供身份可信、状态明确的双向通信，使关键纠偏和异常能及时处理，而不复制完整子会话到主上下文、不靠高频轮询，也不改变结束即释放的执行契约。

## ADDED Requirements

### Requirement: Model-accessible steering uses existing task lifetime
系统 SHALL 提供 localagent_message，以根会话拥有的执行 task ID 为目标发送非空自然语言消息；受管理任务 SHALL 同时校验逻辑任务、目标版本和当前尝试。接口 SHALL 返回独立消息 ID 及可查询投递状态，并复用与用户详情聊天相同的 FIFO、安全边界和终态受理顺序，不创建第二个执行循环。完成或关闭的任务 SHALL 明确拒绝消息，不转发主会话或新建 worker；原生用户详情聊天 SHALL 继续可用。

#### Scenario: Steer during a command
- **WHEN** 主会话向正在运行测试的 worker 发送改变方向的消息
- **THEN** 消息入队并提示安全边界处理，不宣称测试已经停止或 worker 已阅读

#### Scenario: Message races with completion
- **WHEN** 消息提交与自然结束同时发生
- **THEN** 要么受理后纳入本次执行结算，要么明确拒绝并保留失败原因；不静默丢弃、不复活任务

### Requirement: Receipt is not semantic acknowledgement
消息 SHALL 区分提交、入队、进入会话、扩展消费、失败或取消；需要确认的纠偏 SHALL 另有 worker 显式 acknowledgement，包含所确认消息 ID、目标版本、采用的方向及已有工作影响。进入会话和 handled（由扩展消费） MUST NOT 被呈现为模型理解完成。对重复内容的不同消息 SHALL 使用不同身份；对相同重试消息 ID SHALL 幂等。

#### Scenario: Worker acknowledges the new target
- **WHEN** worker 明确确认一条目标版本 3 的纠偏并说明下一步
- **THEN** 主会话可观察该消息的显式确认及内容，任务方向版本更新为已确认；仅 queued 或 entered 时仍显示待确认

### Requirement: Worker reports are bound to runtime identity
系统 SHALL 提供 localagent_report，支持 acknowledgement、blocked、scope_change、interface_change、checkpoint、delivered、failed 结构化事件。报告来源 SHALL 由运行时绑定的根会话、generation、执行 task ID、逻辑任务和尝试确定，不信任模型传入的发送者身份。worker SHALL 只能报告自己的执行；不能更新其他任务、接受自己交付、派生 worker 或取得新的工具授权。

#### Scenario: Forged or stale identity
- **WHEN** worker 尝试报告其他任务，或已终态/旧 generation 的回调提交事件
- **THEN** 报告被拒绝或标记迟到，不修改当前执行、文件责任和验收状态

#### Scenario: Root uses a worker-report operation
- **WHEN** 没有真实 worker 绑定的根会话调用 localagent_report
- **THEN** 返回清晰的身份不适用错误，不伪造某个 worker；该身份校验不改变原工具集合

### Requirement: Meaningful events wake the coordinator without log flooding
需要决策的 blocked、scope_change、interface_change、解锁依赖的 checkpoint、失败和终态 SHALL 主动通知根主会话；普通进度 SHALL 留在任务面板/日志。事件 SHALL 带可幂等去重的身份，通知 SHALL 有界，完整交接可从逻辑任务读取。同一次交付报告与执行终态 SHALL 合并为一次完成唤醒，不将 UI transcript 全量注入主模型。相同事件重试 SHALL 不重复推进状态或持续触发回合。

#### Scenario: Report and terminal callback overlap
- **WHEN** worker 先报告 delivered，随后自然结算触发原有终态通知
- **THEN** 主会话收到一次带交付摘要的终态唤醒，任务仍待验收，资源和执行终态只结算一次

#### Scenario: Routine progress and missing completion report
- **WHEN** worker 连续执行多个普通工具，或没有调用 delivered 就正常结束
- **THEN** 普通工具活动不逐条唤醒主模型；正常结束仍通过既有终态路径交付，并明确缺失结构化交付证据

### Requirement: Blocked workers hand off and release
blocked 报告 SHALL 包含问题、证据、已尝试方案、建议、已修改文件、验证状态与剩余工作。worker SHALL 先完成安全交接再自然结束，不能无限 idle 等待答复。尚有不受影响的工作时 SHALL 可先用 scope/interface 事件请求决策并继续该部分；不能继续时 SHALL 报 blocked。终态后决策 SHALL 通过同一逻辑任务的新实例继续。

#### Scenario: No safe work remains
- **WHEN** worker 需要用户决定且已无安全可继续工作
- **THEN** worker 交付现场后结束，释放 session 和容量；逻辑任务在执行结算后为 blocked，而非 accepted

### Requirement: Cancellation remains distinct from communication
发送纠偏、暂停意图或关闭协调模式 MUST NOT 被描述为已中止工具或已撤销副作用。停止 SHALL 继续使用 task_kill 的独立取消路径，且不自动回滚已有修改；外部副作用 SHALL 保持既有审批与幂等责任。Plan/审批限制 SHALL 不被消息入口或 worker 报告绕过。

#### Scenario: Stop requested while tool is running
- **WHEN** 用户要求立即停止而普通纠偏尚在队列中
- **THEN** 主会话可使用独立 kill，并说明已有修改可能保留；排队消息得到取消/失败状态，不用消息回执冒充停止确认
