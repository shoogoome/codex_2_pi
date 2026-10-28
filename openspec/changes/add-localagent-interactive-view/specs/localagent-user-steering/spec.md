# Spec Delta

## Purpose

允许用户在一次性 LocalAgent 执行期间通过子会话聊天纠正方向，使每条干预都有明确的排队与投递结果，同时保留任务结束即释放执行资源、不允许复活或递归创建其他 agent 的原有边界。

## ADDED Requirements

### Requirement: Accept natural-language intervention only for the active child task
系统 SHALL 仅向当前选中的、尚未关闭输入受理的运行中 LocalAgent 接收非空自然语言消息。每次提交 SHALL 有独立身份和明确的提交、排队、进入子会话、被扩展处理、失败或取消状态；排队确认 MUST NOT 被表述为模型已阅读或处理完成。

#### Scenario: Intervene during a tool call
- **WHEN** 用户向正在执行工具的子任务发送“先不要继续修改，先解释发现”
- **THEN** 消息针对该子任务排队，界面说明其将在后续安全边界进入执行，不宣称正在执行的工具已被立即打断

#### Scenario: Submit blank text or an unsupported command
- **WHEN** 用户提交空白文本，或试图在子会话执行会话切换等斜杠控制命令
- **THEN** 空白文本不发起请求，控制命令被明确拒绝而不在主会话执行，用户可继续编辑未成功发送的内容

#### Scenario: An extension handles or rejects input
- **WHEN** 子任务输入经过扩展处理而被消费，或投递过程失败
- **THEN** 界面显示“已由扩展处理”或明确失败原因，不伪造模型已收到的用户消息，不静默丢弃失败提交的文本

### Requirement: Deliver steering at safe execution boundaries
系统 SHALL 在当前 assistant 回合及其工具调用完成后的安全边界，将已排队消息作为子会话的用户输入纳入后续执行。多条已接收消息 SHALL 按提交顺序处理，并保留各自的投递状态；系统 MUST NOT 为了干预重新 fork、并发运行两个相互冲突的子会话执行循环，或绕过工具权限边界。

#### Scenario: Multiple messages while the agent is busy
- **WHEN** 用户连续提交两条内容相同或不同的消息
- **THEN** 系统按提交顺序保留两次独立提交，正确关联排队与进入子会话状态，不因文本相同误合并或重复投递

#### Scenario: Input crosses an automatic recovery boundary
- **WHEN** 已接收的干预遇到子任务自动重试、压缩恢复或自动续跑
- **THEN** 消息继续属于同一任务，并在执行允许时投递；中间的单次 agent run 结束不提前宣告整个任务完成

### Requirement: Serialize input admission with terminal completion
系统 MUST 对消息受理与终态关闭建立唯一顺序：关闭先发生时明确拒绝新消息；消息先被接收时，自然完成 SHALL 等待该消息被投递并纳入本次任务处理，或获得明确的失败/取消结果。系统 MUST NOT 在已确认排队后静默释放并丢弃消息，也 MUST NOT 在终态后重新启动 agent。

#### Scenario: Submission wins the completion race
- **WHEN** 用户消息已被接收，而初始执行恰好准备自然结束
- **THEN** 任务在同一个尚未释放的子会话中处理该消息后再完成，不先通知完成后又复活

#### Scenario: Completion wins the submission race
- **WHEN** 输入受理已关闭，随后用户按 Enter
- **THEN** 系统明确提示任务已结束或正在结束、消息未发送，并保留用户文本，不向主 agent 或新建 agent 投递

### Requirement: Preserve one-shot cleanup and single terminal delivery
系统 SHALL 在本次任务及已接收干预结束后释放子会话、执行订阅和容量占用，且只产生一次最终任务通知。查看界面或保留只读记录 MUST NOT 延迟这些释放。kill、根会话关闭及不可恢复错误 SHALL 关闭输入受理，并将尚未进入子会话的消息明确标记为取消或失败。

#### Scenario: Finish after a user intervention
- **WHEN** 子 agent 完成已接收的干预且没有剩余工作
- **THEN** 最终通知包含干预后的最终结果，运行时引用和容量被释放一次，完成记录只读且不能继续发送消息

#### Scenario: Kill races with submission and settlement
- **WHEN** kill 与提交消息、自然完成几乎同时发生
- **THEN** 系统选择唯一终态，未处理输入得到明确取消结果，不重复通知、不重复释放，也不在 kill 后启动下一轮

#### Scenario: Output or notification failure
- **WHEN** 展示记录、文本输出或终态通知写入失败
- **THEN** 系统报告可观测错误，但仍释放可执行 session、订阅和容量，不无限等待记录写入

### Requirement: Maintain worker isolation and inference inheritance
系统 SHALL 保持 LocalAgent 的叶子 worker 限制、启动时 provider/model/thinking 继承及后续请求 Fast/UltraFast 有效状态跟随。聊天干预 MUST NOT 激活完整主会话生命周期、改变主会话模型设置，或授权子 agent 创建 fork、teammate 或 team。

#### Scenario: Intervene with a recursive-spawn request
- **WHEN** 用户在子会话要求创建另一个 agent 或 team
- **THEN** 子任务仍受叶子 worker 工具门禁约束，不能因聊天入口而取得递归创建能力

#### Scenario: Parent changes speed while child is running
- **WHEN** 主会话切换 Fast/UltraFast 状态后，子任务因用户干预发起后续请求
- **THEN** 请求遵守既有速度状态继承契约，且不因此切换子任务启动时继承的 provider/model/thinking
