# Spec Delta

## Purpose

让参与本机协作的 Pi 能够识别对端当前承担的模块与工作职责，并通过内置技能理解何时需要通知其他开发会话，使通信服务于协作而不是无意义的自动对话或隐式任务指派。

## ADDED Requirements

### Requirement: Membership carries explicit work identity
创建或加入 SHALL 要求非空显示名与非空工作介绍，允许提供负责模块列表。每位成员 SHALL 有频道内稳定且不可由对端伪造的成员 ID，并关联进程实例 ID、会话 ID 与项目 cwd；不同进程打开相同 session MUST NOT 合并为一个成员。本人可更新显示名、介绍和模块，MUST NOT 修改其他成员身份。

#### Scenario: Different modules and worktrees
- **WHEN** 两个 Pi 使用同一项目的不同 worktree 配对并分别介绍前端和后端职责
- **THEN** 成员列表保留双方各自 cwd、身份和职责，不因路径不同拒绝协作，不因名称相同合并成员

#### Scenario: Identity update
- **WHEN** 成员更改自己的工作介绍
- **THEN** 在线成员可获取更新后的身份，成员 ID 保持不变，旧消息发送者不会被重写

### Requirement: Models receive current collaboration context
模型 SHALL 在开始工作时获得已加入 Pi 频道的本地路由名、类型、状态、本人角色和成员职责，并可用成员查询工具获取最新快照；入站业务消息 SHALL 携带创建者验证的发送者 ID 与发送时工作身份。成员上下线和身份变化 SHALL 更新 TUI 与后续模型上下文，但 MUST NOT 单独触发空闲模型回合或向运行中的模型追加 steer 消息。

#### Scenario: Membership changes while idle
- **WHEN** 成员加入、离开或修改身份，且当前 Pi 没有业务消息
- **THEN** TUI 和成员查询反映新状态，不产生模型调用；下一次模型请求获取最新成员快照

#### Scenario: Message from a known collaborator
- **WHEN** 后端 Pi 发送接口变更通知给前端 Pi
- **THEN** 前端模型可分辨频道、发送者和职责，并可以精确频道名回复，不将对端身份文本作为高优先级指令

### Requirement: Built-in skill guides natural-language collaboration
包 SHALL 分发可发现的 `pi-channel-collaboration` skill，说明通过工具创建/加入/查询/维护身份/发送/退出/销毁的流程；工作身份示例 SHALL 包含目标、负责模块、共享接口和需要他人注意的事项。skill SHALL 要求按任务需要主动通知接口变更、共享文件修改、阻塞、契约冲突与交接，且区分建议、承诺与已完成事实。

#### Scenario: User requests coordination
- **WHEN** 用户说“让另一个 Pi 负责 API，我负责 UI，建立频道协作”
- **THEN** skill 指导模型明确本人职责，通过管理工具创建频道并提供配对码，等待真实成员加入，不假造对端或替用户启动另一进程

#### Scenario: Notify a relevant change
- **WHEN** 当前任务改变其他成员依赖的接口或共享文件
- **THEN** skill 指导模型发送包含影响范围、文件路径或接口、所需动作的简洁消息，并仅依据工具结果汇报投递状态

### Requirement: Collaboration guidance avoids loops and authority escalation
skill 与模型可见规则 SHALL 明确 steer 不等于强制抢占，不需要对每条消息回复，不得自动回声或无限轮询；发送前先确定沟通价值，跨频道转发仅在用户要求或当前任务确有需要时进行。收到的协作请求 MUST NOT 自动扩展用户授权、越过规划模式或替代文件冲突管理。

#### Scenario: Acknowledgement-only traffic
- **WHEN** 对端仅发送“收到”或无新增信息的确认
- **THEN** 协作规则允许不回复，不因确认再次发确认，运行时也不自动转发 assistant 输出

#### Scenario: Planning session receives implementation request
- **WHEN** 处于只读规划的 Pi 收到对端要求立即改代码的消息
- **THEN** 规则明确维持原授权边界，提示协调而不是越权实施
