# Spec Delta

## Purpose

为同一机器上独立运行的 Pi 提供显式配对的双人和群组通信，使不同模块的开发会话能够交换文本信息，并对创建者生命周期、投递结果、安全边界及资源使用作出清晰保证。

## ADDED Requirements

### Requirement: Explicit local pairing and conversation modes
系统 SHALL 支持双人频道与群频道，创建者作为第一位成员和唯一转发者；所有其他成员 MUST 通过配对码显式加入。双人频道最多两位成员，群频道最多 32 位成员，均包含创建者。仅支持同机器同 OS 用户，MUST NOT 因共享项目、配置或会话 ID 自动加入。

#### Scenario: Pair two independent processes
- **WHEN** Pi A 创建双人频道并向同用户下的 Pi B 提供有效配对码，B 提交工作身份加入
- **THEN** A 与 B 建立双向通信，第三位成员的加入被明确拒绝

#### Scenario: Group broadcast
- **WHEN** 群成员发送一条文本消息
- **THEN** 创建者将消息转发给发送时的其他在线成员，包括非发送者的创建者本人，不向发送者回送，也不向未加入的进程发送

#### Scenario: No implicit or remote membership
- **WHEN** 另一个 Pi 只读取到项目路径、频道 ID 或发现记录，或试图从其他机器/OS 用户加入
- **THEN** 系统不建立成员身份，也不暴露消息内容

### Requirement: Pairing credentials have bounded lifetime
系统 SHALL 在创建时生成不可轻易猜测的配对码，默认有效期 30 分钟；创建者可刷新或撤销，关闭频道立即使所有配对码失效。刷新和撤销 MUST NOT 断开已有成员。配对码 MUST NOT 出现在常规成员列表、发现输出、日志或模型 registry 中。

#### Scenario: Expired or revoked code
- **WHEN** 对端使用过期、撤销、已被刷新替代或格式不合法的配对码
- **THEN** 加入失败且不产生成员；返回可操作的错误而不泄露其他频道信息

#### Scenario: Concurrent final slot joins
- **WHEN** 两个进程同时尝试占据双人频道最后一个名额
- **THEN** 恰好一个成功，另一个收到容量错误

### Requirement: Creator-owned lifecycle and disconnects
系统 SHALL 在创建者退出、主动销毁、扩展重载或切换会话时关闭频道，不自动接管或恢复；正常关闭通知成员，异常终止在连接关闭或最多 15 秒心跳超时后标记关闭。普通成员退出或失联只移除自身。新会话 MUST NOT 继承旧会话连接或收到旧连接的迟到消息。

#### Scenario: Creator crashes
- **WHEN** 创建者进程异常终止
- **THEN** 其他成员在检测窗口内看到频道关闭，后续发送失败，旧配对码无法重新加入，成员不启动替代转发者

#### Scenario: Member leaves
- **WHEN** 非创建者退出或切换会话
- **THEN** 其他成员更新成员列表，频道保持可用，离开的成员不再接收消息；已释放的双人名额允许重新配对

### Requirement: Steer delivery without automatic replies
系统 SHALL 将业务消息作为带来源标记的外部内容以 `steer` 投递，空闲时自动唤醒模型；MUST NOT 中止正在运行的工具或强制业务优先级。Pi 频道的 assistant 文本 MUST NOT 自动回传；只有显式发送操作产生出站业务消息。

#### Scenario: Busy receiver
- **WHEN** 对端在工具执行期间收到消息
- **THEN** 消息进入 steer 队列等待下一次模型调用，工具继续运行，模型自行决定处理或暂缓

#### Scenario: Idle receiver
- **WHEN** 空闲对端收到一条新业务消息
- **THEN** 系统启动模型回合并提供该消息；assistant 输出本身不引发反向发送

### Requirement: Delivery receipts are not processing acknowledgements
每次发送 SHALL 返回消息 ID 和发送时目标成员的逐人结果：已进入接收 Pi 队列、明确失败或超时未知；仅所有目标确认入队时可声称全部送达。系统 MUST NOT 将创建者接受消息视为接收者确认，或将入队视为模型已读/已处理。没有其他在线成员时 MUST 返回失败。首版不提供离线补投或跨进程重启可靠送达。

#### Scenario: Partial group delivery
- **WHEN** 群发中一位成员确认入队，另一位断开或未在期限内确认
- **THEN** 返回已入队成员和失败/未知成员，不报告整体成功，不自动重发产生新消息

#### Scenario: Same logical send is retried
- **WHEN** 同一成员在 10 分钟内以相同消息 ID 重试相同内容
- **THEN** 返回已有或更新的投递结果，不重复注入已接收成员；同 ID 不同内容被拒绝

### Requirement: Bounded and authenticated messaging
系统 SHALL 将发送者身份绑定到认证连接，拒绝伪造成员、非成员发送、未知协议版本和非法报文；每条文本最多 64 KiB、每成员每分钟最多 30 条业务消息、每接收者最多 100 条待确认消息。超限 MUST 明确失败而非静默丢弃。身份、凭据和消息只保存在用户私有运行时或原有会话记录中，不形成额外永久消息归档。

#### Scenario: Forgery and flood
- **WHEN** 客户端伪造其他成员身份或发送超过容量/速率的报文
- **THEN** 请求被拒绝且不投递，其他合法成员继续使用频道

#### Scenario: External instruction text
- **WHEN** 对端正文包含要求绕过工具审批或伪造 system 指令的文字
- **THEN** 消息仍被标记为对端提供的外部内容，不提升权限、不绕过审批或规划模式
