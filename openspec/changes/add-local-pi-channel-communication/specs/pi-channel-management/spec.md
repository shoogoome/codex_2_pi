# Spec Delta

## Purpose

在现有 Channel 管理入口中提供一致的本机 Pi 通信管理体验，让用户和模型都能创建、配对和维护频道，同时保留 HTTP 与微信频道既有配置、通信方向和自动回复行为。

## ADDED Requirements

### Requirement: TUI manages Pi channel lifecycle
`/channel` TUI SHALL 提供 Pi 双人/群频道创建、配对加入、查看成员和职责、修改本人介绍、退出，以及创建者专用的销毁、配对码刷新/撤销。创建和加入 SHALL 收集工作身份。列表 SHALL 显示类型、创建者、成员数和连接状态，销毁 SHALL 有明确确认步骤。配对码仅在创建结果或显式查看/刷新动作中显示。

#### Scenario: Create and join through TUI
- **WHEN** A 在面板选择创建群频道并填写名称及工作介绍，B 在面板输入配对码和本人介绍
- **THEN** A 获得配对码，双方可在成员详情看到彼此的工作身份

#### Scenario: A member attempts destruction
- **WHEN** 非创建者查看或尝试销毁频道
- **THEN** 销毁动作不可用且底层请求被拒绝，成员只能退出自身

### Requirement: Model-callable management shares the same rules
系统 SHALL 提供 `channel_manage` 工具，支持 `create`、`join`、`list`、`members`、`update_identity`、`leave`、`destroy`、`pairing` 操作；工具与 TUI 使用相同验证、角色权限和生命周期规则，非交互模式下不依赖终端面板。销毁 MUST 要求显式 `confirm=true`；创建者的退出 MUST 提示使用销毁操作而不能静默断群。禁用 Channel 扩展运行时时创建、加入和发送 MUST 被拒绝。

#### Scenario: Natural-language creation
- **WHEN** 模型为用户调用创建工具并传入类型、频道名和工作身份
- **THEN** 工具返回频道标识、本地精确路由名、本人身份、角色、配对码及到期时间，模型无需编辑配置文件

#### Scenario: Permission and cancellation safety
- **WHEN** 工具请求未确认的销毁、非创建者的配对码管理或参数不合法的加入
- **THEN** 返回明确错误且不修改现有连接或成员

### Requirement: Named sending and routing remain unambiguous
`channel_send` SHALL 保留 `channel` 和 `content` 参数，并支持 Pi 频道；可提供消息 ID 以重试同一逻辑发送。Pi 频道使用当前实例本地唯一、不区分大小写的路由名，MUST NOT 静默覆盖已有 HTTP、微信或 Pi 名称。群广播不支持群内定向私信；需要私聊时创建独立双人频道。

#### Scenario: Join with a conflicting name
- **WHEN** 加入的远端频道名称与当前实例已有路由名冲突
- **THEN** 系统要求指定不冲突的本地别名，原有路由保持不变

#### Scenario: Send compatibility
- **WHEN** 模型以原有两参数形式发送 HTTP / 微信消息
- **THEN** 保持原有路由和出站行为；发送 Pi 消息时返回本机协议的逐成员投递结果

### Requirement: Management views do not disrupt connections
打开、刷新或关闭面板，查看状态，修改本人介绍，以及编辑无关 HTTP / 微信频道 MUST NOT 重启、销毁或重新配对 Pi 频道。显式 `/channel restart` SHALL 只重启持久化外部传输，并说明临时 Pi 频道保持不变。原有 HTTP / 微信配置格式、方向限制和环境变量兼容 SHALL 保持不变；无 Pi 消息介入的外部回合 SHALL 保留双向自动回复。Pi 入站介入混合回合时 MUST 撤销该回合的自动回复目标，避免将协作内容自动外发；此时回复外部频道必须显式发送。

#### Scenario: Open panel while peers communicate
- **WHEN** 创建者反复打开面板或编辑微信配置
- **THEN** Pi 频道 ID、配对码有效性和现有成员连接保持不变，通信不被管理 UI 中断

#### Scenario: Mixed-source turn does not leak collaboration
- **WHEN** HTTP / 微信触发的回合执行期间收到 Pi 协作消息
- **THEN** 后续 assistant 文本不自动回传到原外部目标，模型须显式选择发送频道

#### Scenario: Disabled external direction
- **WHEN** 现有 HTTP / 微信频道在当前会话为 inbound-only
- **THEN** `channel_send` 继续拒绝出站，本机协议扩展不放宽该限制
