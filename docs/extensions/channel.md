# Channel 扩展

`extensions/channel` 是 Pi 的具名多通道通信中心。它把协议连接、会话挂载、通信方向和名称路由拆开管理：一个 Pi 会话可同时使用 HTTP / 微信 ClawBot / MCP / dots Channel 和本机 Pi 双人/群频道，模型能看到名称、能力及 Pi 成员职责，并通过 `channel_send` 把阶段性产物发送到指定接收方。

原来的单 HTTP 入站模式仍兼容，见“旧配置兼容”。

## TUI 面板

在交互模式执行：

```text
/channel
```

面板列表会同时显示：

- Channel 名称（也是 Pi 路由时使用的名称）
- 协议：`http` / `wechat` / `mcp`（当前会话服务）/ `dots`（MCP Events 桥接）/ `pi`（双人或群）
- 当前 Pi 会话的方向：`对端 → Pi` / `Pi → 对端` / `双向`
- 范围：`多会话` / `全部会话`
- 当前会话是否挂载
- `listening`、`ready`、`connected`、`occupied`、`error` 等实时状态

常用按键：

| 按键 | 作用 |
|---|---|
| `a` | 选择协议并新建 Channel，包括 MCP 会话服务和 Pi 双人/群频道 |
| `j` | 使用配对码加入 Pi 频道 |
| `Enter` | 查看 Channel 详情 |
| `e` | 编辑名称、协议、范围、连接参数，以及**当前 Pi 会话自己的方向** |
| `Space` | 启用 / 禁用 |
| `m` | 为当前会话挂载 / 卸载“多会话” Channel |
| `r` | 重启外部 HTTP/微信/MCP 传输并重新读取配置；Pi 频道不受影响 |
| `l` | 打开通用登录/认证选择器；可选择已有可认证 Channel，或选择协议新建后认证 |
| `x` | 删除配置（微信凭证保留，避免误删后无法恢复） |
| `Esc` | 返回 / 关闭面板 |

HTTP/微信/MCP/dots 配置写入 `~/.pi/agent/channel/config.json`，目录权限为 `0700`，文件权限为 `0600`。Token 会以明文保存在这个用户私有文件中，面板显示时会遮罩。

## 本机 Pi 双人/群频道

### 创建与配对

首版仅支持 **macOS/Linux、同机器、同 OS 用户** 的独立 Pi 进程，通过私有 Unix domain socket 通信，不监听外部 TCP 端口。Windows 不支持，不会自动降级到联网通信。不同 worktree/cwd 可以配对；相同 cwd、session ID 或共享配置不会自动加入。

1. 在创建者 Pi 打开 `/channel`，按 `a` 选择 Pi 双人或群频道，填写频道名、本人显示名和工作介绍，可声明负责模块。
2. 创建后取得配对码和到期时间，在需要加入的另一个 Pi 打开 `/channel`，按 `j` 输入配对码与对端自己的工作身份。
3. 在 Pi 频道详情查看创建者、成员数、连接状态和各成员职责；可更新本人介绍、退出，创建者还可查看/刷新/撤销配对码或确认销毁。

`direct` 双人频道最多 **2 人**，`group` 群频道最多 **32 人**，均包含创建者。群消息广播给其他在线成员，不回送发送者；不提供群内定向私信，私聊请另建双人频道。显示名可以相同，成员 ID 不会因此合并。路由名在当前 Pi 内不区分大小写且必须唯一；加入时同名冲突需要显式 `local_name`，不会覆盖已有 HTTP/微信/MCP/Pi 路由。

本人身份示例：

```json
{
  "displayName": "后端 Pi",
  "introduction": "负责登录 API 与测试，不修改前端。共享接口：POST /login；响应字段变动会先通知 UI。",
  "modules": ["server/auth", "server/tests"]
}
```

工作身份包含稳定成员 ID、进程实例、会话 ID、cwd，以及自己提供的工作介绍。只有本人能改自己的介绍；历史消息保留发送时身份。模型可在后续请求中获取最新成员快照，并用 `channel_manage members` 查询；成员上线、离线、改介绍只更新状态，**不会单独唤醒模型或注入 steer**。

### 自然语言管理与发送

内置 skill：`pi-channel-collaboration`。可说“建立一个频道，我负责 UI，让另一个 Pi 用配对码加入负责 API”，或显式运行 `/skill:pi-channel-collaboration`。模型使用工具操作，不需要手改配置。

```text
channel_manage(action="create", name="登录协作", mode="group", identity={...})
channel_manage(action="join", pairing_code="<配对码>", identity={...}, local_name="登录协作")
channel_manage(action="list")
channel_manage(action="members", channel="登录协作")
channel_manage(action="update_identity", channel="登录协作", identity={...})
channel_manage(action="leave", channel="登录协作")
channel_manage(action="destroy", channel="登录协作", confirm=true)
channel_manage(action="pairing", channel="登录协作", operation="show|rotate|revoke")
channel_send(channel="登录协作", content="POST /login 已增加 code 字段，请前端更新错误映射；测试已通过。")
```

Pi 的 `create` 可显式传 `protocol="pi"`；省略时保持原有 `name/mode/identity` 格式兼容。HTTP/微信/MCP 不需要 Pi 工作身份，使用下节的外部频道参数；MCP 创建参数另见“MCP 会话服务”。

`operation` 取 `show`、`rotate`、`revoke` 之一，不是合并字符串。`destroy` 与配对码管理仅创建者可用；普通成员只能退出自身，创建者的 `leave` 会拒绝并提示使用确认销毁。禁用 `--channel=false` 或 `PI_CHANNEL=0` 时不能创建、加入或发送。

skill 提醒模型在接口/共享文件变更、阻塞、契约冲突和交接时主动通知相关成员，注明影响范围和验证情况；不对纯确认反复回复，不自动轮询，不把频道当作文件锁或任务执行授权。

### 投递与送达语义

Pi 业务消息固定 **`steer` + 空闲自动唤醒**：运行中在下一次模型调用前插入，不强行中止当前工具，由模型决定立即处理还是暂缓。每次唤醒可能产生模型调用费用。

只有显式 `channel_send` 或手工 `/channel send` 才发送 Pi 业务消息，**assistant 文本不会自动回传**。若 Pi 消息介入正在执行的 HTTP/微信/MCP 回合，系统撤销该混合回合的自动回复目标，避免协作内容被自动发给外部；需要回复外部时显式调用 `channel_send`。没有 Pi 消息介入的 HTTP/微信/MCP 回合保持原自动回复行为。

发送结果包含消息 ID、发送时目标成员集合，以及逐成员的已入队、失败或超时未知。只有全部目标确认进入接收 Pi 队列才算全部送达；**入队不等于已读或已处理**。部分成功不能汇报为全成功；没有其他在线成员时发送失败。

为查询同一逻辑发送结果，可在 **10 分钟**内以原正文和原 ID 调用 `channel_send(channel, content, message_id)`；这不会重新广播。同 ID 不同正文会拒绝。`unknown` 可能已经入队，不要自动换 ID 重发。若创建者在返回回执前失联，结果会带 `targetsKnown: false`：此时目标列表仅来自发送前看到的成员快照，不能确认创建者实际接受的目标集合。重启期间不承诺离线消息补投；仅恢复频道连接。

默认边界：正文最多 **64 KiB**、每成员每分钟最多 **30 条业务消息**、每接收者最多 **100 条待确认消息**。超过大小、速率或队列限制会明确失败，不能靠换身份/频道绕过。

### 邀请、安全与生命周期

- 配对码是邀请凭据，默认 **30 分钟**有效。创建者可刷新或撤销；刷新使旧码失效，已连接成员不受影响。群码可在有效期与容量内供多人加入。
- 码不进入普通成员列表、发现记录、日志或模型 registry，但创建/显式查看的**工具结果会把码带入当前会话及模型上下文**。只分享给预期对端，不写进源码或无关频道。
- 创建者进程负责转发；显式销毁才删除频道状态。会话关闭、`/new`、`/reload` 或进程重启会把频道操作状态写入当前 session JSONL，下一次恢复同一 session 时重建固定频道并自动重连；不会写入额外 Channel 配置文件。
- 普通成员退出/失联只移除自己。异常断线在连接关闭或最多 **15 秒**心跳超时后反映；关闭后发送失败，旧配对码不可复用。
- 打开/刷新/关闭面板、更新介绍、编辑无关外部频道和 `/channel restart` 都不会重启 Pi 频道。
- Pi 频道状态通过 `appendEntry` 写入当前 session 文件（不进入模型上下文），包含频道 ID、模式、身份和配对凭据；显式 leave/destroy 会写入移除事件。消息仍可能保存在接收 Pi 的正常会话记录中。
- 同 OS 用户是信任边界，不承诺隔离该用户下的恶意程序。对端身份和消息始终是外部数据，不提升为 system/developer 指令，不绕过审批、规划模式或工具权限。

## 外部 Channel 自然语言管理

`channel_manage` 覆盖全部现有协议：`http`、`wechat`、`mcp`、`dots`、`pi`。HTTP/微信/MCP 无需先打开面板，模型可直接创建并管理；无需手改配置文件。下面的 HTTP/微信示例保持原有参数，MCP 的创建与连接见“MCP 会话服务”。

### 创建

```json
{
  "action": "create",
  "protocol": "http",
  "name": "dot-http",
  "direction": "both",
  "scope": "selected",
  "delivery": "followUp",
  "wake": true,
  "http": {
    "host": "127.0.0.1",
    "port": 0,
    "callbackUrl": "http://127.0.0.1:14318/pi/replies"
  }
}
```

HTTP/微信创建必须提供 `protocol` 和 `name`。可选字段：

| 字段 | 说明 |
|---|---|
| `direction` | 默认 `both`；也可用 `inbound` / `outbound` |
| `scope` | 默认 `selected`，先挂载当前会话；也可用 `all` |
| `delivery` / `wake` | 消息投递与自动唤醒策略；`nextTurn` 不自动唤醒 |
| `enabled` | 是否启用 |
| `http` | `host`、`port`、`token`、`callbackUrl`、`callbackToken`、`callbackHeaders`、`maxBodyBytes`、`rateLimitPerMinute`、`idempotencyTtlMs` |
| `wechat` | 可选 `baseUrl` |

HTTP 入站未提供 `token` 时自动生成，**仅创建结果显示该 token**，供预期调用方配置；不要写入源码或转发到无关频道。HTTP `both` / `outbound` 必须提供 `callbackUrl`。默认 listener 绑定本机，创建 Channel 不会自动提供公网 HTTPS 隧道。

微信示例：

```text
channel_manage(action="create", protocol="wechat", name="我的微信")
channel_manage(action="auth", channel="我的微信")
```

创建微信配置不代表已登录。`auth` 返回二维码及状态文本，不依赖交互面板；仍需用户扫码并在微信确认，不能声称自动完成登录。

### 查询与管理

| 操作 | 参数 |
|---|---|
| 合并列出 Pi 与外部频道 | `action:"list"` |
| 查询外部频道状态 | `action:"status", channel` |
| 更新外部配置 | `action:"update", channel`，以及可选 `name/direction/delivery/wake/http/wechat/mcp` |
| 当前会话挂载 / 卸载 | `action:"mount"` / `"unmount", channel` |
| 启用 / 禁用 | `action:"enable"` / `"disable", channel` |
| 重启外部传输 | `action:"restart", channel?`；省略频道时重启外部传输，不重启 Pi 频道 |
| 协议认证 | `action:"auth", channel`；仅支持注册了认证适配器的协议，MCP 服务支持可选 Bearer token，不走扫码认证 |
| 删除外部配置 | `action:"delete", channel, confirm:true`；仅在用户明确要求删除时执行 |

`list` / `status` 返回脱敏外部状态，不暴露 listener token、callback token 或认证 headers。Pi 的成员、身份、配对及销毁操作仍遵循上一节的权限规则，不能用外部 `delete` 绕过创建者权限。

**配置保存成功与连接就绪是两件事。** 创建或更新后应检查返回的运行时状态：端口占用、缺少微信登录等可能导致 `error` 或尚未就绪。不得把“配置已保存”汇报为“已连接对端”；发送成功也不代表对端已读。

## 多 Channel 与作用域

以下持久化作用域与通信方向适用于外部 Channel。HTTP/微信支持 `selected` 与 `all`；MCP/dots 仅支持 `selected`，只为显式挂载的会话启动服务，拒绝 `all`，避免隐式暴露所有会话。Pi 频道始终双向且必须显式配对，不支持 `all` 自动挂载。

每个 Channel 都有稳定 `id` 和用户可读的唯一 `name`。名称不区分大小写匹配，最长 64 个可打印字符。

### 多会话（`selected`，默认）

新建 Channel 默认使用多会话范围，并先挂载当前会话。之后在其它 Pi 会话打开 `/channel`，选中该 Channel 并按 `m`，即可把那个 session ID 加入或移出挂载列表。旧版 `session` 配置加载时会自动迁移成只挂载原会话的 `selected` 配置，不会丢失 Channel ID、名称或微信登录凭证。

### 全部会话（`all`）

每个加载 Channel 扩展的 Pi 会话都会尝试启动该 Channel。HTTP 入站建议将端口设为 `0`，让每个会话分配独立端口并通过发现文件查询；固定端口在多个进程中会发生正常的端口占用错误。

微信 iLink 对同一机器人使用独占长轮询锁：多会话/全部会话配置中，先获取锁的 Pi 会话显示 `connected` 并负责接收消息，其它会话显示 `occupied`，不会重复消费消息。`occupied` 仅表示**接收轮询**由其它会话持有；所有已挂载且允许出站的会话仍可复用共享凭证、最近联系人和 `context_token` 发送消息。要切换微信的接收会话，先在当前持有者禁用/卸载或关闭会话，再在目标会话按 `r`。

## 每会话独立通信方向

方向按 Pi 会话独立保存并在运行时强制执行，不是单纯标签。同一个微信 Channel 可以配置为：

- 会话 A：`both`（双向）
- 会话 B：`outbound`（Pi → 微信）
- 会话 C：`inbound`（微信 → Pi）

在每个会话自己的 `/channel` 面板中进入详情并按 `e`，修改 `Direction here` 后保存；只会更新当前 session ID 的方向，不覆盖其它会话。

| 配置 | 入站连接 | `channel_send` / 自动回复 |
|---|---|---|
| `inbound` | 接收并注入 Pi | 禁止发送 |
| `outbound` | 不把对端消息交给 Pi | 允许发送 |
| `both` | 接收并注入 Pi | 允许发送；无 Pi 协作消息介入时，由该 Channel 触发的 assistant 文本会自动回到同一对端 |

微信长轮询仍只由一个会话持有。锁持有者会把入站消息经本地私有 Relay 分发给所有已挂载且本会话方向允许入站的 Pi 会话；`outbound` 会话不会收到消息。非锁持有会话仍可复用共享联系人和 iLink `context_token` 发送。一个新微信机器人必须先收到联系人消息，才能确定主动发送目标。

## TUI 消息展示

外部消息进入模型上下文时仍保留完整 `<external_channel_message>` 安全包裹，但 TUI 使用结构化 `details` 单独渲染，不再裸露 XML：

```text
◆ 微信 · wechat
收到的正文
```

按 `Ctrl+O` 展开后可查看来源、接收时间、消息 ID 和目标 Pi 会话；展开视图也不会显示原始 XML。旧会话里没有结构化 `details` 的历史消息会从包裹中提取正文后按相同样式显示。渲染前会移除外部正文中的 ANSI/终端控制序列。

## Pi 名称感知与路由

每次 agent 启动前，扩展都会隐藏注入当前会话名以及已挂载 Channel 的：

- 精确名称
- 协议
- 通信方向
- 作用域
- 当前状态

同时注册工具：

```text
channel_send(channel: string, content?: string, image_path?: string, message_id?: string)
// 必须提供非空 content 或 image_path；图片仅微信支持；message_id 仅用于 Pi 文本同 ID 查询
```

因此下面的跨 Channel 场景可以直接工作：

1. 用户从微信 Channel `我的微信` 发来：“把当前阶段结果发给 `产物群`”。
2. Pi 从 Channel registry 知道 `产物群` 是可出站的具名 Channel。
3. Pi 调用 `channel_send(channel="产物群", content="...")`。
4. 只有工具成功后，Pi 才应确认已经送达。

也可手动发送：

```text
/channel send 产物群 阶段一报告已生成
```

Channel 名称可以包含空格；命令会按已配置名称做最长前缀匹配。

## MCP 会话服务

`protocol="mcp"` 把**当前 Pi 会话**作为 MCP 服务提供给外部客户端，采用官方 MCP SDK 的 [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http)，端点为 `/mcp`。它是服务端能力，不是连接外部 MCP server 的客户端，也不替代 `/mcp` 命令。

### 创建与连接

最小创建请求：

```json
{
  "action": "create",
  "protocol": "mcp",
  "name": "我的会话"
}
```

可选通用字段包括 `direction`（默认 `both`）、`delivery`、`wake` 和 `enabled`。`scope` 只接受 `selected`，创建时先挂载当前会话，**不接受 `all`**。其它会话必须显式挂载才会启动自己的服务；默认随机端口时，每个服务只暴露它所在的 Pi 会话，不会跨会话合并回复。

可选 `mcp` 配置：

| 字段 | 说明 |
|---|---|
| `host` / `port` | 默认 `127.0.0.1:0`，端口 `0` 表示自动分配 |
| `auth` | 默认 `bearer`；显式设为 `none` 关闭鉴权 |
| `token` | `bearer` 模式要求非空，创建时省略则自动生成；`none` 模式不要求 token |
| `maxBodyBytes` | 请求体字节上限 |
| `rateLimitPerMinute` | 请求限流配置 |
| `idempotencyTtlMs` | 入站消息 ID 去重保留时间，默认 10 分钟 |

创建结果包含脱敏频道状态，以及仅供预期连接方使用的 `listenerToken` 和连接配置。例如：

```json
{
  "mcpClientConfig": {
    "url": "http://127.0.0.1:15432/mcp",
    "headers": {
      "Authorization": "Bearer <创建结果中的 token>"
    }
  }
}
```

端口以工具实际返回为准，不要照抄示例端口。将 `mcpClientConfig` 放入支持 Streamable HTTP 和自定义 headers 的 MCP 客户端配置中；token 不应写入源码或无关频道。`list` / `status`、发现文件和模型 Channel registry 不返回 token。`/channel` 面板的新建类型中也可选择 MCP，并编辑监听地址、端口和 token；MCP 不需要 callback URL 或扫码 `auth`。

### 可选鉴权

默认保留 Bearer 鉴权，旧配置省略 `auth` 时也保持此行为。仅清空 token 不会关闭鉴权。需要匿名访问时显式创建：

```json
{"action":"create","protocol":"mcp","name":"本机免鉴权会话","mcp":{"auth":"none"}}
```

已有服务可用 `channel_manage(action="update", channel="我的会话", mcp={auth:"none"})` 关闭鉴权，或在面板将 **MCP auth** 切为 `none`。匿名创建结果只返回 URL，不生成 token，也不返回 `Authorization` header；`list/status` 会显示 `auth:"none"`，工具和面板会提示警告。重新启用可传 `mcp:{auth:"bearer",token:"你的非空 token"}`；若已有 token，省略 token 可继续使用它。面板重新启用且 token 为空时会自动生成。

**关闭鉴权后，任何能连接端点的人都可调用该服务允许的会话工具并读取共享回复**，可能触发模型费用和已授权操作。仅在可信本机环境或上游网关已负责访问控制时使用；关闭 Bearer 不会关闭 Host、Origin、限流和请求大小检查。此选项仅影响 MCP，不改变 HTTP Channel 的鉴权。

### 对外提供的工具

| MCP 工具 | 参数与语义 |
|---|---|
| `pi_session_info` | 返回当前会话名称、ID 和通信能力；不返回 cwd、会话历史或底层工具列表 |
| `pi_send_message` | `{content, id?}`；将文字作为认证的外部 Channel 输入异步投递给当前会话，返回 `accepted` / `duplicate` / `messageId`，不等待模型完成 |
| `pi_read_replies` | `{after?: number, limit?: number, instanceId?: string}`；按游标读取本 Channel 已写入的出站消息，读取本身不会触发模型 |

典型流程：

1. 连接并完成 MCP 初始化，调用 `pi_session_info` 核实会话。
2. 调用 `pi_send_message({content:"请对齐桥接协议", id:"dot-request-1"})`，保留消息 ID。`accepted` 只代表入队，不是处理完成。
3. 稍后调用 `pi_read_replies({after:0})`。响应含 `messages`、`nextCursor`、`oldestCursor`、`truncated` 和服务实例 `instanceId`；每条消息含 `sequence`、`id`、`content`、可选 `replyTo` 和 `sentAt`。
4. 处理成功后保存 `nextCursor`，下次用 `after:nextCursor, instanceId` 继续读取；携带旧实例 ID 会明确返回 `stale_cursor`，须从新实例的游标 0 重新读取。`truncated` 表示旧回复已不在保留窗口内；`instanceId` 变化表示服务已重启，必须丢弃旧游标并从新实例重新读取，不能把重置后的空结果当成旧请求已完成。

重试同一入站逻辑消息时使用原 ID 和相同正文，在去重窗口内返回重复结果，不再次投递；同 ID、不同正文会拒绝。默认缓存时间为 10 分钟，可用 `idempotencyTtlMs` 调整。没有稳定 ID 的重试可能产生重复消息，超时后不要盲目换 ID 重发。

### 方向与回复边界

- `both`：允许 `pi_send_message` 和 `pi_read_replies`。该 Channel 单独触发的 assistant 文本按现有外部回复规则写入信箱；Pi 协作消息介入、与其它外部 Channel 混合，或 MCP 消息介入本地任务（包括启动前的认证/压缩等预处理阶段）时，撤销自动回复目标，需显式 `channel_send`，避免自动转发无关任务内容。
- `inbound`：只允许向 Pi 投递消息；禁止读取回复，也禁止 Pi 向该 Channel 发送。
- `outbound`：禁止向 Pi 投递消息；允许读取回复，Pi 可用 `channel_send` 主动写入信箱。

`channel_send` 的成功仅表示回复已写入信箱，**不是客户端已收到、已读或已处理**。所有通过该 Channel 访问控制的客户端（免鉴权时为任何可连接者）共享同一信箱和会话，不提供客户端间隔离；只把 token 给需要看到该信箱的人。同一模型回合可能合并多条入站消息，`replyTo` 是路由提示，不保证每个入站 ID 都有独立的最终回复。

MCP 只暴露本 Channel 新产生的回复，不自动导出历史会话、其它 Channel 消息、cwd、文件或 read/bash 等底层工具。入站仍受原有 approvals、plan mode 和工具权限约束；不过允许向当前助手发任务本身就可能触发模型费用和已授权工具操作，应按任务入口而非只读接口保护 token。Pi 回答时仍可使用已有会话上下文，因此“不自动导出历史”不代表对回答内容做了隐私脱敏。

### 内存信箱与生命周期

回复信箱最多保留 **100 条 / 总计 1 MiB**，单条最多 **64 KiB**，不是持久存储或可靠离线队列。客户端应及时读取并自行保存需要保留的回复。

服务仅在当前 Pi 进程及挂载会话存活时运行；停用、卸载、关闭会话、`/reload` 或重启服务都会清空未读回复、重置游标并更换 `instanceId`。当前外部 Channel 配置保存流程会重启全部外部传输，因此即使保存的是另一个外部 Channel，也会重置 MCP 信箱；Pi 双人/群频道不受此重启影响。配置仍会保存，恢复会话后可重新启动服务，但不会补投丢失的信箱内容。`port:0` 重启后实际端口也可能改变，应重新查询状态或发现文件。

### 鉴权与远程接入

- 默认所有 `/mcp` 请求要求 Bearer token；显式 `mcp.auth:"none"` 可关闭。`/health` 仅提供不含会话隐私的健康状态。
- 默认监听本机，并校验 Host；默认拒绝所有带 `Origin` 的请求（包括带正确 token 的请求），不支持浏览器直接跨域调用，需要服务端代理。
- 若要让远程客户端连接，必须取得用户授权，并使用 TLS 反代与来源 ACL；若关闭内置 Bearer，应由上游网关提供等效访问控制；不自动创建公网域名、隧道或 OAuth 服务。使用本机默认监听地址的反代应把上游 Host 覆盖为 `127.0.0.1:<实际端口>`，不要透传公网域名绕过或误触 Host 校验。
- 这是 Bearer header 鉴权，不是 OAuth。启用 `bearer` 时客户端必须支持自定义 `Authorization` header，`none` 模式无需该 header；ChatGPT/dot 是否允许配置并能主动调用、持续检查回复，需要在对应账号和客户端实测，不能仅凭服务创建成功宣称已接通。

## dots：Pi ↔ ChatGPT dots

**正式账户模式**：已保存 `~/.pi/agent/channel/dots/account.json` 时自动复用固定 OAuth 账户入口，新建/恢复 Channel 无需重新添加 ChatGPT 连接；一次性配对明确授权整个专用设备集合，Events 可显式订阅 `channel_id="*"` 覆盖未来 dots Channel。没有账户配置时使用下面的会话 listener 模式。见 [固定账户入口](dots-account-bridge.md)。

新增 `protocol="dots"`，使用独立 `dots` 配置：

```json
{
  "action": "create",
  "protocol": "dots",
  "name": "我的 dot",
  "dots": { "host": "127.0.0.1", "port": 0 }
}
```

它复用当前会话消息工具，但额外实现 **MCP 2.0 Events（2026-07-28）** 的 `server/discover`、`events/list`、`events/subscribe`、`events/unsubscribe`。事件为 `pi.message.created`，严格过滤当前 session/channel；ChatGPT 提供 callback URL/签名 secret，Pi 验证 challenge 后持久保存订阅，并将显式出站消息的事件持久排队，经 Standard Webhooks 签名 HTTPS 投递。不是未公开的 Dot API，也不是把普通 MCP 读信误当后台唤醒。

默认 `selected + both + followUp + wake=true`、本机随机端口、自动 Bearer token；显式 `dots.auth="none"` 可关闭鉴权，含事件订阅也对所有可达客户端开放。默认不自动创建域名/隧道/OAuth，不改微信配置。`status` 返回脱敏事件计数；outbox/订阅按 channel+session 私有持久化，手工回复信箱仍为内存。没有订阅不补发历史事件，Webhook 2xx 不代表 dot 已处理。完整配置、临时 HTTPS、认证兼容性和唤醒验收见 [dots Channel](dots.md)。

## HTTP 协议

HTTP Channel 可配置两部分：

- 入站 listener：`host`、`port`、Bearer `token`、请求体/限流/幂等参数。
- 出站 callback：`callbackUrl`、可选 Bearer `callbackToken`、可选固定 headers。

`inbound` 只要求 listener token；`outbound` 只要求 callback URL；`both` 两者都要求。

### 入站 API

```http
POST /v1/messages
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: alert-123
```

```json
{
  "id": "alert-123",
  "source": "alertmanager/prod",
  "content": "生产环境 API 错误率达到 30%，请检查",
  "delivery": "steer",
  "wake": true,
  "metadata": {
    "severity": "critical"
  }
}
```

如果请求省略 `delivery` / `wake`，使用面板中的 Channel 默认值。面板里的 `Auto-trigger Pi` 对应 `wake`：设为 `yes` 时，空闲状态收到消息会自动启动一轮 Pi；设为 `no` 时只写入会话/TUI，等待下次用户输入。显式请求值仍可覆盖默认值。

支持的投递语义：

| `delivery` | 行为 |
|---|---|
| `steer` | 空闲时可立即唤醒；运行中在下一次 LLM 调用前插入 |
| `followUp` | 当前 agent 完成后排队执行 |
| `nextTurn` | 等下一次真实用户 prompt，强制不唤醒 |

首次接受返回 `202 Accepted`。`Idempotency-Key` 或显式 `id` 默认保留 10 分钟；重复请求返回 `duplicate: true`，不会再次注入。`GET /health` 是不暴露会话信息的最小健康检查。

### 出站 callback

`channel_send` 或双向自动回复会向 callback URL 发送：

```http
POST /your/callback
Content-Type: application/json; charset=utf-8
Authorization: Bearer <callbackToken>   # 配置后才有
X-Pi-Channel: 产物群
```

```json
{
  "type": "channel/message",
  "channel": {
    "id": "...",
    "name": "产物群",
    "protocol": "http"
  },
  "session": {
    "id": "...",
    "name": "发布检查",
    "cwd": "/path/to/repo"
  },
  "content": "阶段一报告已生成",
  "sentAt": "2026-08-03T00:00:00.000Z"
}
```

非 2xx 响应会让 `channel_send` 失败，不会伪装成成功。

## 协议认证适配器

`login` 不是微信专用动作。Channel 核心维护协议认证适配器注册表，每个适配器声明协议名称、认证动作标签、默认 Channel 名称、默认配置工厂和认证实现。`/channel auth`、兼容别名 `/channel login` 以及面板 `l` 都只调用这个通用注册表：

1. 选择一个已配置且支持认证的 Channel；或
2. 选择一个认证协议，创建该协议的默认 Channel；
3. 执行适配器定义的扫码、OAuth、设备码或其它认证流程。

当前注册的第一个适配器是微信 ClawBot。后续接入其它需登录协议时，新增适配器即可，无需修改命令或面板路由。

也可用 `/channel auth --protocol wechat` 只显示指定协议的目标；`/channel auth <Channel 名称>` 直接认证指定 Channel。

## 微信 ClawBot / iLink 协议

实现参考 MIT 项目 [`shenjiecode/pi-wechat-assistant`](https://github.com/shenjiecode/pi-wechat-assistant)，复用微信 iLink Bot 的扫码登录、`getupdates` 长轮询、`context_token` 和 `sendmessage` 协议；Channel 扩展自行实现多配置、作用域、方向和名称路由。

### 登录

执行 `/channel auth`（或兼容别名 `/channel login`），在通用选择器中选择：

- `扫码登录「微信」 · 微信 ClawBot`：刷新已有微信 Channel；或
- `新建 微信 ClawBot Channel 并扫码登录`：创建默认多会话的微信 Channel，并把当前会话设为双向。

也可以使用 `/channel auth --protocol wechat` 过滤到微信协议，或进入微信 Channel 详情页按 `l`。TUI 显示终端二维码后，用微信扫码并在手机确认。
4. 凭证写入：

```text
~/.pi/agent/channel/wechat/<channel-id>/credentials.json
```

联系人 `context_token`、游标和最后联系人写在同目录 `state.json`，均为 `0600`。

当前版本支持微信文字、语音转写文本、引用文本和**图片入站**。图片会从微信可信 CDN 下载，必要时按 iLink `aeskey` 做 AES-128-ECB 解密，经大小与格式校验后，以 Pi 原生 image block 注入当前模型；纯图片消息也会自动补充“请分析图片内容”的文本并按 Channel 的 Delivery/Auto-trigger 设置触发。图片可通过私有多会话 Relay 分发给其它允许入站的挂载会话。`channel_send` 出站支持文本和本地图片；文件、视频、语音媒体发送暂不支持。

### 发送图片

可以直接告诉 Pi：**“把 `output/chart.png` 发到 `wx` 渠道”**。模型使用精确 Channel 名称调用：

```json
{
  "channel": "wx",
  "image_path": "output/chart.png"
}
```

附带文字（可选，最多 1200 字符）时：

```json
{
  "channel": "wx",
  "content": "这是本次生成的图表",
  "image_path": "/absolute/path/chart.png"
}
```

- `image_path` 是本地普通文件路径，相对路径按当前 Pi 项目 cwd 解析；不支持 HTTP URL、base64 或 Markdown 图片语法。
- 支持 JPEG、PNG、GIF、WebP，校验文件头而非扩展名；单张最多 **10 MiB**，每次工具调用发送一张。
- 可以显式发送项目外的图片，例如 `generate_image` 返回的绝对路径；这会将该文件上传到微信，请只指定你有意分享的图片。
- 当前会话必须挂载 Channel，方向为 `outbound` 或 `both`。联系人必须先向机器人发送消息，以获得接收人和 `context_token`；主动发送使用最后活跃联系人。
- `occupied` 会话也可共享凭证和联系人状态发送图片，无需抢占长轮询锁。
- `content` 可省略；有说明时，先发图片，再单独发送一条文字消息，使用同一接收人。微信 iLink 会拒绝同一个 `item_list` 混放图片和文字（`invalid arguments`）。超过 1200 字符的长文本请单独发送。
- HTTP、MCP 和本机 Pi 频道拒绝 `image_path`；不要与仅用于 Pi 文本查询的 `message_id` 同时传入。
- `/channel send` 仍是文本命令；自动回复仍只回传 assistant 文本，不会自动上传工具生成的图片，发送图片需要显式调用 `channel_send`。
- 工具仅在图片及可选说明均发送成功后返回 `delivered: true`，表示接口接受，不代表联系人已读。若只有说明发送失败，返回 `delivered: false`、`imageDelivered: true` 并提示“图片已发送”，此时只补发文字，不重发图片。其它失败或超时不自动重发；发送阶段超时可能已送达，重试可能重复。

故障诊断：API 错误会保留接口路径和错误码，例如 `/ilink/bot/getuploadurl: prepare failed (code ...)` 或 `/ilink/bot/sendmessage: prepare failed (code ...)`。`prepare failed` 是服务端错误，不能仅凭这个字符串断定图片损坏或登录失效；请按失败阶段排查，不自动重发。

底层流程：原图 MD5 + 随机 AES-128-ECB/PKCS#7 加密 → `/ilink/bot/getuploadurl`（`media_type: 1`）→ 微信 CDN 二进制上传 → 从响应头 `x-encrypted-param` 获取下载凭据 → `/ilink/bot/sendmessage`（`item_list[].type: 2`）。`media.aes_key` 是 hex 密钥文本的 base64，`mid_size` 为加密后大小。Bot token 只发给 iLink API，不发给 CDN。

### 自动回复与主动发送

- `both`：无 Pi 协作消息介入时，微信消息触发的 Pi assistant 文本会回发给同一联系人；混合回合需显式选择目标发送。
- `outbound`：不会把微信正文交给 Pi；Pi 仍可用 `channel_send` 发给最后活跃联系人。
- `inbound`：正文进入 Pi，但不会向微信自动回复，`channel_send` 也会拒绝。
- 多会话下只有一个会话执行接收轮询；其它显示 `occupied` 的会话若方向允许出站，仍可通过共享状态发送。首次发送前必须已有联系人给该机器人发过消息，以便锁持有会话记录目标和 `context_token`。
- 微信消息已显示但 Pi 没有自动回复时，进入 `/channel` → 微信详情 → `e`，确认 `Delivery` 为 `steer`（或 `followUp`）且 `Auto-trigger Pi` 为 `yes`；`nextTurn` 会强制关闭自动触发。

## 配置文件示例

通常应通过 TUI 写入。下面用于审计或高级配置：

```json
{
  "version": 1,
  "channels": [
    {
      "id": "alerts-http",
      "name": "生产告警",
      "enabled": true,
      "protocol": "http",
      "direction": "inbound",
      "scope": {
        "kind": "all",
        "sessionIds": []
      },
      "delivery": "steer",
      "wake": true,
      "http": {
        "host": "127.0.0.1",
        "port": 0,
        "token": "replace-me",
        "maxBodyBytes": 65536,
        "rateLimitPerMinute": 30,
        "idempotencyTtlMs": 600000
      },
      "createdAt": "2026-08-03T00:00:00.000Z",
      "updatedAt": "2026-08-03T00:00:00.000Z"
    },
    {
      "id": "release-room",
      "name": "产物群",
      "enabled": true,
      "protocol": "http",
      "direction": "both",
      "sessionDirections": {
        "session-id-a": "both",
        "session-id-b": "outbound",
        "session-id-c": "inbound"
      },
      "scope": {
        "kind": "selected",
        "sessionIds": ["session-id-a", "session-id-b", "session-id-c"]
      },
      "delivery": "steer",
      "wake": true,
      "http": {
        "host": "127.0.0.1",
        "port": 0,
        "token": "",
        "maxBodyBytes": 65536,
        "rateLimitPerMinute": 30,
        "idempotencyTtlMs": 600000,
        "callbackUrl": "https://example.com/pi-callback",
        "callbackToken": "replace-me"
      },
      "createdAt": "2026-08-03T00:00:00.000Z",
      "updatedAt": "2026-08-03T00:00:00.000Z"
    }
  ]
}
```

配置加载时会校验版本、唯一名称、默认/各会话方向所需参数、URL、端口、限额、Token 和挂载范围。无效配置不会让 Pi 崩溃，会在面板与 `/channel status` 中显示错误。

## 命令

| 命令 | 作用 |
|---|---|
| `/channel` | 打开 TUI 面板 |
| `/channel status` | 输出当前会话全部 Channel 状态和发现文件 |
| `/channel restart` | 重读配置并重启当前会话挂载的 HTTP/微信/MCP 传输；Pi 频道保持不变 |
| `/channel auth [name]` | 打开通用协议认证选择器，或直接认证指定 Channel |
| `/channel login [name]` | `auth` 的兼容别名，不绑定具体协议 |
| `/channel auth --protocol <protocol>` | 只选择指定协议的已有/新建认证目标 |
| `/channel send <name> <message>` | 手工向具名 Channel 发送文本 |

## 发现文件

每个活跃 Pi 会话写一份：

```text
~/.pi/agent/channels/<session-and-hash>.json
```

version 2 记录会话 ID/名称、PID、cwd，以及当前 Channel 的名称、协议、方向、状态和 HTTP/MCP 实际端口及地址；Pi 频道只写无秘密的状态摘要，不包含任何 Token 或配对码，不用于自动加入或授权。HTTP/MCP `port: 0` 的调用方应从这里读取实际端口和 URL；MCP 的 URL 带 `/mcp` 路径。

正常 shutdown / reload 会清理本实例的记录；强制 kill 后可能残留，调用方需结合 PID、状态和 `/health` 判断。

## 旧配置兼容

设置 `PI_CHANNEL_TOKEN` 时会生成一个只读虚拟 Channel：

```text
name=legacy-http · protocol=http · direction=inbound · scope=selected
```

它继续支持：

| 环境变量 / flag | 默认值 |
|---|---:|
| `PI_CHANNEL_TOKEN` | 无；为空时不创建 legacy Channel |
| `PI_CHANNEL_HOST` | `0.0.0.0` |
| `PI_CHANNEL_PORT` | `4317` |
| `PI_CHANNEL_MAX_BODY_BYTES` | `65536` |
| `PI_CHANNEL_RATE_LIMIT_PER_MINUTE` | `30` |
| `PI_CHANNEL_IDEMPOTENCY_TTL_MS` | `600000` |
| `PI_CHANNEL=0` / `--channel=false` | 禁用全部 Channel 运行时 |
| `--channel-host` / `--channel-port` | 覆盖 legacy host / port |

面板可查看和重启它，但要修改仍需调整 `PI_CHANNEL_*`。

## 安全边界

- HTTP 入站必须使用 Bearer Token；比较使用恒定时间逻辑，日志与发现文件不记录 Token 或正文。
- 新建 HTTP listener 默认绑定 `127.0.0.1:0`。若改成 `0.0.0.0`，应使用主机防火墙；公网接入必须放在 TLS 反向代理和来源 ACL 后。
- Channel 输入固定标记为认证的外部输入，不冒充 system/developer 指令，也不绕过 approvals、plan mode 或工具权限。
- 每条可唤醒消息都可能触发模型调用和费用；外部系统应聚合事件并使用稳定幂等键。
- 出站 callback 会携带当前 session 名、ID 与 cwd；不要把 callback 配到不可信服务。
- 微信 token 只保存在当前 OS 用户的私有文件中；不要提交 `~/.pi/agent/channel/` 的内容。
- 微信图片仅允许从受信任的微信 CDN HTTPS 域名下载，拒绝重定向；单张下载上限 10 MiB，每条微信消息最多处理 5 张，支持 JPEG、PNG、GIF、WebP。图片以 base64 随 session/私有 Relay 保存，会增加会话文件和模型上下文体积。
- 微信图片出站仅读取显式指定的本地普通文件，实际读取有大小上限；上传固定使用微信可信 CDN，拒绝重定向，CDN 请求不携带 bot token。上传会将图片交给微信，路径没有项目目录沙箱，请谨慎选择分享文件。
