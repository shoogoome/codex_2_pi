# dots 固定账户入口与首次 OAuth 绑定

已实现：固定账户 MCP 资源服务器、成熟 AS OAuth access-token 验证、专用设备集合配对、稳定逻辑 Channel、持久消息/ACK/游标及 MCP Events；通过本地集成测试。**真实 ChatGPT 登录/刷新/停止轮询后的后台唤醒，必须由用户首次连接后验收，不能用测试替代。**

## 简单使用流程

部署一次并保存本机账户连接后：

1. 在 ChatGPT 添加**一个**固定 HTTPS MCP 连接，选择 OAuth，完成首次登录与授权。
2. OAuth 成功后，用户把网关本机生成的一次性配对码交给自己的 dot，通过 `pi_pair_account` 绑定这个专用 Pi dots 设备集合。
3. Pi 执行 `/reload` 加载新扩展，然后 `/channel` 新建 **dots**，或 `channel_manage(action="create", protocol="dots", name="我的 dot")`。
4. 新 Channel 自动使用本机保存的账户连接，注册持久逻辑 ID；恢复 Channel 只重绑定执行节点，不重建 ChatGPT 插件或 OAuth client。
5. 若用户明确授权当前及未来的整个专用 dots 集合，让 dot **一次订阅** `pi.message.created`：`{session_id:"account", channel_id:"*"}`。之后新 Channel 不用重新配置插件或逐一新增事件订阅。也可以只订阅一个明确的 Channel，但不自动扩大其监听范围。

OAuth、账户配对和事件订阅是三个首次操作。刷新失败、撤销、权限范围变化或公网 URL 变化仍可能要求重新授权，不承诺永久免操作。

## 两种运行模式

- 已有 `~/.pi/agent/channel/dots/account.json`：`dots` 自动进入**账户模式**，不再启动每会话 MCP listener。所有逻辑 Channel 共用一个固定 OAuth resource URL。
- 没有该文件：保留 [会话模式](dots.md)，启动本机 MCP+Events listener，可做独立联调；它不能代替固定账户绑定。

本机账户连接格式（设备密钥不是 ChatGPT 的 OAuth token）：

```json
{
  "gatewayUrl": "https://dots.example.com",
  "deviceToken": "<仅给 Pi 的强随机设备密钥>"
}
```

使用 `saveDotsAccountProfile(agentDir, profile)` 保存，私有目录 0700、文件 0600。不要把 deviceToken 填进 ChatGPT、发送给 dot 或提交代码。配置更改后需重启/恢复 Channel；旧连接的未发 outbox 不会静默转到新账户。

## 协议与身份

```text
ChatGPT / 现有 dot
    │ OAuth 2.1：授权码 + PKCE S256；自动 access/refresh grant
    ▼
固定 HTTPS account bridge /mcp ← 成熟 AS issuer / JWKS
    │ RS256 access token + iss/aud/client_id/exp/nbf/scope
    │ 专用账户 ownerSub + 每次显式 channel_id
    ├─ 逻辑 Channel A → 当前 Pi 执行节点
    └─ 逻辑 Channel B → 另一显式登记节点

Pi → 本地持久 outbox → HTTPS /device/reply → 账户持久回复/ACK
                       ↓
        匹配订阅持久事件队列 → 签名 Webhook → ChatGPT/dot
```

- `get_profile` 返回 `hash(issuer, sub)` 派生的不变 opaque ID，并提供 `openai/profile` metadata；不是用户名、邮箱、session ID 或每次登录随机值。
- `channel_id` 是持久逻辑 ID。`session_id` 是可替换执行节点，不能作为账户身份。Events 的 `session_id` 固定为 `account`，消息 payload 保留真实逻辑 `channel_id`。
- 专用单账户集合由一次性本地码绑定一个已认证 OAuth subject，之后其它 subject 不能读取、发送或订阅。配对明确授权此设备注册的当前和未来 **dots** Channel，不包含其它 Pi/微信频道。
- 每次设备注册换一个 lease；旧实例 ACK/回复被 409 拒绝后停止，不能反复自动抢注册。无全局 `select` 状态，不按最近活跃联系人/会话兜底路由。
- 本版一个设备密钥对应一个专用集合，不是任意多租户/多设备权限平台。

## 账户 MCP 工具

| 工具 | 行为 |
|---|---|
| `get_profile()` | 返回当前 OAuth subject 的稳定 profile ID，配对前也可用 |
| `pi_pair_account({code})` | 一次绑定专用集合；同 subject 幂等，不能换绑其它 subject |
| `pi_list_channels()` | 当前专用集合的逻辑 Channel，包含离线节点 |
| `pi_get_channel({channel_id})` | 显式查询，无全局选择状态 |
| `pi_send_message({channel_id,id,content})` | 持久入队；同 ID/正文去重，不同正文冲突 |
| `pi_read_replies({channel_id,after?,limit?})` | 读取持久游标与回复，不隐式 ACK |
| `pi_ack_replies({channel_id,through})` | 保存用户应用层已处理游标 |

`accepted` 是入队，不是处理完成；Pi 设备 dispatch 后的设备 ACK 仅表示进入 Pi 队列，不是模型完成；Webhook 2xx 是平台接收；dot 读回 probe/应用 ACK 才是应用层处理证据。

## OAuth 部署

代码是 OAuth **资源服务器**，不自制登录/授权服务器。按 [官方 ChatGPT 认证指南](https://developers.openai.com/plugins/build/auth) 对接成熟 AS：

- 公开 `/.well-known/oauth-protected-resource` 及对应 `/mcp` 后缀版本，401 challenge 指向资源 metadata。
- AS 提供 OAuth/OIDC discovery、PKCE `S256`、真实 resource/audience、客户端注册/预注册和刷新授权。
- 当前验证固定 issuer 同源 JWKS、RS256 RFC9068 access token 的 `typ=at+jwt`、签名、`iss/aud/client_id/exp/nbf` 及必需 scopes；不接受 ID token 或任意 token 指定的 URL。
- AS 为 ChatGPT 配置 JWT access tokens，不能把 Authelia 默认 opaque access token 当 JWT。
- CIMD/DCR 可用时遵循平台配置；不支持时预注册一个稳定 client，不能按 Pi session 新建 client。ChatGPT 管理页若要求 client ID，只需首次填写；公开客户端+PKCE 不需 client secret。
- 严格照 AS issuer identification 模式配置官方 redirect URI；不要猜 callback_id、忽略 `resource` 或绕过 TLS。

构建：`npm run build:extensions` 同时输出 `extensions/channel/dist/dots-account.js`（独立 Node 18+ bundle）。运行：

```sh
node extensions/channel/dist/dots-account.js --config /private/dots-account-config.json
```

配置示例（私有文件 0600）：

```json
{
  "host": "127.0.0.1",
  "port": 14319,
  "stateDir": "/private/dots-account-state",
  "resourceUrl": "https://dots.example.com/mcp",
  "issuer": "https://auth.example.com",
  "clientId": "pi-dots-chatgpt",
  "deviceToken": "<与 Pi 本机账户连接相同的强随机密钥>"
}
```

可选 `scope` 为必须存在于 access token 的 scopes（默认 `openid`）；平台若要自动刷新，应在授权时请求 `offline_access`。`bootstrapCode` 省略则自动生成，首次码存于私有 `stateDir/pairing-code.txt`，配对后删除。不要把码写进服务日志。只通过 TLS 反代开放账户 MCP 入口，不绕过 OAuth；设备 API 单独验证密钥与 lease。

现有部署如使用 `*.merlinlin.com`，所有 resource/issuer/redirect 相关 URL 保留实际外网端口 `:23457`。现有 SSO 用户和密码配置不可直接改写；使用成熟 AS 升级需备份、预检、健康检查及用户授权。

## 持久化与限制

- Gateway `stateDir/account.json` 持久保存 owner subject、逻辑 Channel、lease、入站消息/接受 ACK、回复、游标及应用 ACK；目录 0700、文件 0600，串行原子保存、单写者锁。
- Events 订阅/outbox 持久，单 Channel 与显式集合订阅分别隔离；方向改为 inbound-only 时撤销该 Channel 的待发事件，包括集合队列中的事件。
- Pi 本地出站队列私有持久，稳定 UUID 重试，收到网关持久接受后移除。关闭/重启可能重复投递，必须幂等，不宣称 end-to-end exactly-once。
- 最大64 Channel、每 Channel 1000条 inbox/回复，ACK过的旧记录有界清理；去重窗口也随有界清理结束，不是永久历史。
- 设备 poll 按条数和编码字节分页；只出站 Channel 用低频 heartbeat 维持在线。已认证设备、OAuth主体、失败认证分开限流，避免正常多 Channel 被旧全局预算饿死。
- 本地出站最多100条/1MiB，单条64KiB UTF-8，另限制 JSON 编码后的 wire size；失败保留重试，凭据/lease失效停止并要求显式恢复。
- Events `cursor:null` 仍表示不提供协议历史 replay；持久 pending outbox 不保证过期/无订阅期间补发所有消息，权威回复可通过持久 `read/ack` 恢复。
- 关闭/离线保留逻辑历史，online 是近期 lease 活动而不是 dot 模型状态。进程需受监管重启，公网入口需固定；Quick Tunnel 不满足长期 URL 稳定性。

## 真实平台验收

本地测试覆盖 JWT 拒绝、账户隔离、配对、多 Channel 共用连接、lease、持久 ACK/游标、集合一次订阅、重启、大消息与回调安全，不等于真实平台验收。用户首次连接后必须另外验证：

1. Authelia 登录 → 授权码/PKCE → access token → `get_profile` → 一次配对。
2. access 到期刷新；撤销 refresh 后不能继续访问或降级为无认证。
3. 明确授权指定 Channel 或整个专用集合的真实事件订阅；平台提供 callback 与 secret。
4. dot 停止主动轮询后，Pi 延迟非敏感 probe，核对平台新任务与应用 ACK。
5. 新建/恢复 Channel 不重建插件/OAuth client；单个 Channel 授权不得自动扩大，集合授权只涵盖该专用设备集合。
6. 过滤、退订/续订、重复/未知结果、重启、scope/主体不匹配与回声抑制。
7. 微信实发和多联系人/context_token 测试另行授权，不因 dots 可用就自动接通微信。
