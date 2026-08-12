# Channel 扩展

`extensions/channel` 是 Pi 的具名多通道通信中心。它把协议连接、会话挂载、通信方向和名称路由拆开管理：一个 Pi 会话可同时挂载多个 HTTP / 微信 ClawBot Channel，模型能看到这些 Channel 的名称与能力，并通过 `channel_send` 把阶段性产物发送到指定接收方。

原来的单 HTTP 入站模式仍兼容，见“旧配置兼容”。

## TUI 面板

在交互模式执行：

```text
/channel
```

面板列表会同时显示：

- Channel 名称（也是 Pi 路由时使用的名称）
- 协议：`http` / `wechat`
- 当前 Pi 会话的方向：`对端 → Pi` / `Pi → 对端` / `双向`
- 范围：`多会话` / `全部会话`
- 当前会话是否挂载
- `listening`、`ready`、`connected`、`occupied`、`error` 等实时状态

常用按键：

| 按键 | 作用 |
|---|---|
| `a` | 新建 Channel |
| `Enter` | 查看 Channel 详情 |
| `e` | 编辑名称、协议、范围、连接参数，以及**当前 Pi 会话自己的方向** |
| `Space` | 启用 / 禁用 |
| `m` | 为当前会话挂载 / 卸载“多会话” Channel |
| `r` | 重启并重新读取配置 |
| `l` | 打开通用登录/认证选择器；可选择已有可认证 Channel，或选择协议新建后认证 |
| `x` | 删除配置（微信凭证保留，避免误删后无法恢复） |
| `Esc` | 返回 / 关闭面板 |

配置写入 `~/.pi/agent/channel/config.json`，目录权限为 `0700`，文件权限为 `0600`。Token 会以明文保存在这个用户私有文件中，面板显示时会遮罩。

## 多 Channel 与作用域

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
| `both` | 接收并注入 Pi | 允许发送；由该 Channel 触发的 assistant 文本会自动回到同一对端 |

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
channel_send(channel: string, content: string)
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

当前版本的 Channel 协议层支持微信文字、语音转写文本和引用文本；图片/文件媒体桥接尚未并入通用 `channel_send`。

### 自动回复与主动发送

- `both`：微信消息触发的 Pi assistant 文本会回发给同一联系人。
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
| `/channel restart` | 重读配置并重启当前会话挂载的 Channel |
| `/channel auth [name]` | 打开通用协议认证选择器，或直接认证指定 Channel |
| `/channel login [name]` | `auth` 的兼容别名，不绑定具体协议 |
| `/channel auth --protocol <protocol>` | 只选择指定协议的已有/新建认证目标 |
| `/channel send <name> <message>` | 手工向具名 Channel 发送文本 |

## 发现文件

每个活跃 Pi 会话写一份：

```text
~/.pi/agent/channels/<session-and-hash>.json
```

version 2 记录会话 ID/名称、PID、cwd，以及当前挂载 Channel 的名称、协议、方向、状态和 HTTP 实际端口，但不包含任何 Token。HTTP `port: 0` 的调用方应从这里读取实际端口。

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
