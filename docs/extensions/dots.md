# dots Channel：Pi ↔ 现有 ChatGPT dots

`protocol="dots"` 是 Channel 的独立外部协议类型。它连接用户**现有的 dot**，不创建替代 dot，不使用未公开的 Dot API，也不自动转发微信或其它会话。

> 已支持固定账户模式：保存一次 `channel/dots/account.json` 后，创建/恢复 dots Channel 会自动登记到同一个 OAuth 账户网关，不再按 session 启动公网 listener；集合事件订阅可覆盖明确授权的未来 Channel。下文主要描述无账户配置时的会话模式。正式使用见 [账户入口与首次 OAuth 绑定](dots-account-bridge.md)，真实平台登录/刷新/后台唤醒仍需验收。

## 协议与网络路径

```text
dot → HTTPS /mcp → pi_send_message → 当前 Pi 会话
Pi → channel_send → 回复信箱 + 持久事件 outbox
                         ↓
       签名 HTTPS webhook → ChatGPT 提供的 callback → dot 事件任务

dot → pi_read_replies → 主动读取本 Channel 的内存回复信箱
```

- 工具入口使用 MCP Streamable HTTP，支持现有 MCP 客户端初始化，也支持 MCP 2.0 `2026-07-28` 的 `server/discover`、工具与事件请求。
- 事件采用 OpenAI 的 [MCP Events 集成](https://developers.openai.com/plugins/build/mcp-events)：Webhook 模式，Standard Webhooks 签名；不是通过永久 SSE 连接来保证后台唤醒。
- 每个显式挂载会话有自己的 listener、内存信箱、事件订阅与 outbox，不合并其它会话。
- **网络入口需另配。** 默认只监听 `127.0.0.1:0`。不会自动改 merlin 网关、创建域名、启动隧道或部署 OAuth。
- 微信仍是独立 Channel；本类型只实现 Pi ↔ dots。微信实发、多联系人映射和 `context_token` 有效期需独立授权与验收。

## 创建

通过 `channel_manage`：

```json
{
  "action": "create",
  "protocol": "dots",
  "name": "我的 dot",
  "direction": "both",
  "scope": "selected",
  "dots": {
    "host": "127.0.0.1",
    "port": 0
  }
}
```

也可在 `/channel` 中按 `a`，选择 **dots · MCP Events**。默认双向、`selected`、`followUp`、`wake=true`，生成随机 Bearer token；创建结果包含 `listenerToken` 和 `mcpClientConfig`，`list/status` 不返回 token。

`selected` 是唯一允许的范围，不能用 `all` 隐式暴露所有会话。额外挂载会话必须显式操作；随机端口会各自分配。不支持图片发送。

### 配置

以下字段置于 `dots` 对象中，不是 `mcp` 或 `http`：

| 字段 | 默认 / 约束 |
|---|---|
| `host` | `127.0.0.1` |
| `port` | `0`，系统分配；可指定 0–65535 |
| `auth` | `bearer`；显式 `none` 可关闭入口鉴权 |
| `token` | 创建时省略自动生成；`auth=bearer` 时必需 |
| `maxBodyBytes` | 65536，允许 1024–10485760 |
| `rateLimitPerMinute` | 30，允许 1–10000，另有 HTTP 请求限流 |
| `idempotencyTtlMs` | 600000，允许 1000–86400000 |
| `subscriptionTtlMs` | 3600000，允许 60000–86400000；每次授予有限订阅期限 |
| `retryIntervalMs` | 1000，允许 100–60000；队列检查间隔及退避基数 |
| `maxAttempts` | 6，允许 1–20；超出后进入 dead 状态 |

**ChatGPT 接入兼容性：** Bearer 不是 OAuth；只有客户端能提供自定义 Authorization 头时，默认 Bearer 入口才可直接使用。不会因为填入一个 HTTPS URL 就自动完成认证适配。

对于用户明确授权的无认证临时联调：

```json
{
  "action": "create",
  "protocol": "dots",
  "name": "dot 联调",
  "dots": { "auth": "none" }
}
```

此模式也允许事件发现和订阅，但**所有可达者共享同一个 Channel 的消息与订阅命名空间**，没有用户身份认证和客户端隔离。Callback challenge 只证明对回调的控制权，事件签名只验证出站通知，不能替代入站身份认证。任何拿到公开地址的人都可能发任务、读回复或注册回调，请勿承载私密任务或公开分享地址。停止联调后关闭入口；生产应采用客户端兼容的鉴权及明确身份映射。

## 远程 HTTPS

云端 dot 无法访问你的 `127.0.0.1`。需用户授权后将一个专用 listener 放在 TLS 反代后，例如临时 Cloudflare Tunnel 或自有固定域名。反代须覆盖上游 Host 为 `127.0.0.1:<实际端口>`，不能直接透传公网 Host；不应添加 Origin 头。

创建/重启后以 `channel_manage status` 返回的实际端口为准，`port=0` 会变化。实际运行地址后加 `/mcp`。使用临时隧道不构成长期稳定部署；生产需要固定入口、进程监管、重启恢复与鉴权。

## 消息工具

| 工具 | 用法 |
|---|---|
| `pi_session_info` | 核实会话名称/ID、channelId、通信方向、事件名称及脱敏队列计数，不输出 cwd/历史/本地工具 |
| `pi_send_message` | `{ "content": "技术消息", "id": "stable-request-id" }`；返回入队结果，不等待 Pi 完成 |
| `pi_read_replies` | `{ "after": 0 }`；保存 `nextCursor` 与 `instanceId` 后继续读取 |

入站同 ID、同正文在去重窗口内不重复投递，同 ID、不同正文拒绝；入站去重是内存状态，不是跨重启 exactly-once 保证。

Pi 用 `channel_send(channel="我的 dot", content="结果")` 写回复，并为**已经存在且未过期的订阅**生成事件。没有订阅时仍可读信箱，但不会以后补发历史事件。用户本地回合与 dots 消息混入同一轮时，会撤销自动回复目标，需显式 `channel_send`，避免把本地任务内容泄露给 dot。

## 事件：`pi.message.created`

仅暴露本 Channel 显式发送的新消息，不广播整个对话或其它 Channel 的消息。`events/list` 给出事件定义及严格过滤条件：

```json
{
  "name": "pi.message.created",
  "arguments": {
    "session_id": "<pi_session_info 返回的会话 ID>",
    "channel_id": "<pi_session_info 返回的 channelId>"
  }
}
```

两项必须与当前 listener 完全一致，不允许订阅其它会话/Channel。它们是路由边界，不是微信联系人身份；本版没有实现 account/contact 用户过滤，不要假装已完成多联系人隔离。

事件 payload：

```json
{
  "eventId": "evt_<reply-id>",
  "name": "pi.message.created",
  "timestamp": "2026-10-18T00:00:00.000Z",
  "data": {
    "session_id": "...",
    "channel_id": "...",
    "message_id": "...",
    "content": "Pi 的消息",
    "reply_to": "可选的入站消息 ID"
  },
  "cursor": null
}
```

### 订阅流程

1. ChatGPT 调用 `server/discover`，看到 `capabilities.events`，再调用 `events/list`。
2. 用户在 ChatGPT/dot 中明确要求监听 `pi.message.created`，指定这两个过滤值。变更事件能力后可能需要在 ChatGPT 端重新扫描插件。
3. ChatGPT 调用 `events/subscribe`，提供**平台真实生成的** HTTPS callback URL 与 `whsec_` 签名密钥。不要手工编造平台 URL/密钥来声称已订阅。
4. Pi 验证过滤、密钥与 callback；先发带 Standard Webhooks 签名的一次性 challenge，核对平台回显后才保存订阅。
5. Pi 后续发送消息时，先持久保存匹配订阅的 outbox，再异步投递；事件 ID 在重试间保持不变，签名时间和签名每次重新生成。
6. ChatGPT 在 `refreshBefore` 前刷新订阅；`ttlMs:null` 也只授予有限期限，不承诺永久订阅。`events/unsubscribe` 幂等撤销匹配订阅并取消待发任务。

入口的 `direction=inbound` 不提供 Events；`outbound` 允许读回复和订阅，但不允许 `pi_send_message`。这只是 Pi ↔ dot 消息流方向，订阅管理仍需访问 MCP。

## 持久化、重试与边界

每会话状态路径：

```text
~/.pi/agent/channel/dots/<channel-id>/<session-id>/events.json
```

- 私有目录 0700、文件 0600，原子替换、串行写入、单写者锁。文件含回调签名密钥和待发消息，不得提交到代码库或发送给其它 Channel。
- 订阅、密钥轮换窗口、pending/dead outbox 跨正常重启恢复。更换入口 token/auth 会改变所有者绑定并撤销旧订阅/outbox，需 dot 重新订阅。
- 最大 32 订阅、1000 个待发/死信任务、16 MiB 状态文件；满时拒绝继续排队，不静默丢弃。
- 暂时性失败指数退避、有限次数；410/413 等终止错误不重试。状态查询输出 `subscriptions/pending/dead`，不暴露回调 URL、密钥或消息正文。死信本版不提供自动重放管理工具，排障后重新发送需用户决定，注意潜在重复。
- Callback 仅 HTTPS，限制请求/响应与超时；每次连接重新检查 DNS、公网 IP 并固定连接目标，保留 TLS hostname 校验，不跟随重定向，阻断本地和私网目的地。
- 当前**手工回复信箱仍为内存**，上限 100 条 / 1 MiB；重启清空。Events outbox 持久化不等于所有历史回复持久化，也不承诺协议历史 replay（`cursor:null`）。
- 停用/卸载使投递暂停；重新启用后只恢复仍有效的订阅/任务。外部 Channel 配置保存可能重启其它传输：手工信箱重置，但 dots outbox 可恢复；删除 Channel 不删除其私有状态文件，后续清理应显式进行。
- 至少一次投递：关闭/超时可能发生“平台已收但本地尚未记录 ACK”，恢复后仍用同一 eventId 重试。消费端应幂等；不宣称端到端 exactly-once。

## 验收与送达语义

区分以下事实：

1. `pi_send_message.accepted`：Pi 已接受入队。
2. `channel_send` 成功：回复写入本地信箱，匹配现有订阅的事件已持久排队。
3. Webhook `2xx`：平台接收 ACK，不证明 dot 已处理。
4. 平台产生新任务并读回非敏感 probe：才是实际后台唤醒/应用层处理的证据。

单元和本地集成测试验证协议/持久化/签名/回调安全/重试/恢复，不等于真实 ChatGPT 的后台唤醒验收。真实验收应由用户在 dot 端授权订阅，结束活动轮询，再延迟从 Pi 发一个非敏感 probe，核对平台新任务和读回结果。另测过滤不匹配、重复、续订、过期、退订、断线与重启。不要因为 dot 只是在线主动读了信，就声称 Events 唤醒成功。
