# channel 扩展

为正在运行的 Pi 会话提供一个通用、带鉴权的 HTTP 入站 Channel。外部告警平台、CI、IDE、定时任务或其它服务可以向 HTTP 接口提交消息；扩展将其规范化为 `channel/message`，通过 `pi.sendMessage()` 写入当前会话，并按 `steer` / `followUp` / `nextTurn` 语义决定何时交给模型以及是否主动唤醒。

## 能力

- 配置 `PI_CHANNEL_TOKEN` 后随 `session_start` 自动启动；未配置 token 时保持静默 inactive，不开放端口。
- 默认监听 `0.0.0.0:4317`，因此局域网、容器外或其它网卡可以访问；客户端应使用机器实际 IP，不能把 `0.0.0.0` 当目标地址。
- `POST /v1/messages` 强制 Bearer Token，使用恒定时间比较，不记录 token 或消息正文。
- 支持 `steer`、`followUp`、`nextTurn` 与 `wake`；`nextTurn` 会强制规范化为不唤醒。
- 请求体默认上限 64 KiB；默认全局限流 30 条/分钟。
- 支持 `Idempotency-Key`，或以调用方显式提供的消息 `id` 作为隐式幂等键；默认保留 10 分钟，失败投递会释放预留以允许重试。
- 固定使用 `channel/message` custom type，不冒充用户消息；内容会标记为“认证过的外部输入，而非 system/developer 指令”。
- 每个活跃会话写一份 `~/.pi/agent/channels/*.json` 发现记录，包含 session、PID、cwd、监听地址与端口，但不含 token。
- `/reload`、new/resume/fork 等会话切换会先关闭旧 listener 再重建；`session_shutdown` 关闭连接并仅删除属于当前实例的发现记录。
- `GET /health` 提供无鉴权、无会话信息的最小健康检查。
- `/channel status` 查看状态；`/channel restart` 按最新 flag/env 配置重启。

## 配置

推荐通过 `settings-env` 在全局或项目 `settings.json` 中提供环境变量：

```json
{
  "env": {
    "PI_CHANNEL_TOKEN": "请替换成足够长的随机字符串",
    "PI_CHANNEL_HOST": "0.0.0.0",
    "PI_CHANNEL_PORT": "4317"
  }
}
```

也可以在启动 Pi 前直接设置环境变量。Token 只支持环境变量，刻意不提供 CLI 参数，避免秘密出现在 shell history 或进程参数中。

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `PI_CHANNEL_TOKEN` | 无 | 必填；为空时 listener 不启动 |
| `PI_CHANNEL_HOST` | `0.0.0.0` | HTTP bind host |
| `PI_CHANNEL_PORT` | `4317` | HTTP 端口；设为 `0` 时由系统分配空闲端口并写入发现文件 |
| `PI_CHANNEL_MAX_BODY_BYTES` | `65536` | JSON 请求体上限，范围 1 KiB–10 MiB |
| `PI_CHANNEL_RATE_LIMIT_PER_MINUTE` | `30` | 当前 Pi 实例的全局每分钟唯一消息上限 |
| `PI_CHANNEL_IDEMPOTENCY_TTL_MS` | `600000` | 幂等键保留时间，范围 1 秒–24 小时 |
| `PI_CHANNEL=0` | — | 禁用 listener |
| `--channel=false` | 默认启用 | 禁用 listener |
| `--channel-host <host>` | 无 | 覆盖 `PI_CHANNEL_HOST` |
| `--channel-port <port>` | 无 | 覆盖 `PI_CHANNEL_PORT` |

CLI host/port 优先于环境变量。非法端口、host 或限额配置不会让 Pi 崩溃，只会拒绝启动 Channel 并通过 `/channel status` 或 UI 通知显示原因。

## HTTP API

### 健康检查

```http
GET /health
```

响应：

```json
{"ok":true,"service":"pi-channel"}
```

该接口不需要鉴权，且不会暴露 cwd、session ID、模型或 token。

### 投递消息

```http
POST /v1/messages
Authorization: Bearer <PI_CHANNEL_TOKEN>
Content-Type: application/json
Idempotency-Key: alert-123
```

请求体：

```json
{
  "id": "alert-123",
  "source": "alertmanager/prod",
  "content": "生产环境 API 错误率达到 30%，请检查",
  "delivery": "steer",
  "wake": true,
  "metadata": {
    "severity": "critical",
    "service": "api-gateway"
  }
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 来源标识，1–128 字符，格式 `[A-Za-z0-9][A-Za-z0-9._:/-]*` |
| `content` | 是 | 非空字符串，作为外部输入进入模型上下文 |
| `id` | 否 | 1–128 个可打印字符；提供后也作为默认幂等键 |
| `delivery` | 否 | `steer`（默认）、`followUp` 或 `nextTurn` |
| `wake` | 否 | 默认 `true`；`nextTurn` 下无论传什么都不会唤醒 |
| `metadata` | 否 | JSON object，保存在 custom message details 中 |

首次接受返回 `202 Accepted`：

```json
{
  "accepted": true,
  "duplicate": false,
  "messageId": "alert-123",
  "delivery": "steer",
  "wake": true
}
```

幂等重试仍返回 `202`，但不重复投递：

```json
{
  "accepted": true,
  "duplicate": true,
  "messageId": "alert-123"
}
```

`202` 只表示 Pi 已接受/排队消息，不代表模型已经完成处理，也不会在当前 HTTP 请求中返回模型回答。

### curl 示例

```bash
curl "http://192.168.1.10:4317/v1/messages" \
  -H "Authorization: Bearer $PI_CHANNEL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: alert-123" \
  -d '{
    "source": "alertmanager",
    "content": "生产环境出现告警，请检查",
    "delivery": "steer",
    "wake": true
  }'
```

## 投递语义

| `delivery` | 空闲时 | 模型正在运行时 |
|---|---|---|
| `steer` | `wake=true` 时立即启动一轮 | 当前 assistant turn 的工具调用完成后，在下一次 LLM 调用前送达 |
| `followUp` | `wake=true` 时立即启动一轮 | 等当前 agent 没有工具调用和 steering 消息后送达 |
| `nextTurn` | 不唤醒 | 排到下一次真实用户 prompt，`wake` 被忽略 |

消息最终调用形态：

```ts
pi.sendMessage(
  {
    customType: "channel/message",
    content: "<external_channel_message>…",
    display: true,
    details: normalizedMessage,
  },
  {
    deliverAs: delivery,
    triggerTurn: wake && delivery !== "nextTurn",
  },
);
```

Channel 不绕过现有 approvals、plan mode 或工具权限。模型收到外部消息后若要执行写文件、shell、MCP 等动作，仍走原有安全闸门。

## 发现文件

启动成功后写入：

```text
~/.pi/agent/channels/<session-and-hash>.json
```

示例：

```json
{
  "version": 1,
  "instanceId": "…",
  "sessionId": "…",
  "pid": 12345,
  "cwd": "/path/to/project",
  "host": "0.0.0.0",
  "port": 4317,
  "localUrl": "http://127.0.0.1:4317",
  "startedAt": "2026-08-02T12:00:00.000Z"
}
```

文件权限为 `0600`，但其中不保存 token。正常 shutdown 会清理；进程被强制 kill 时可能留下旧文件，调用方应结合 PID 与 `/health` 判断是否仍有效。

## HTTP 状态码

| 状态码 | 含义 |
|---:|---|
| `202` | 已接受或幂等重复 |
| `400` | JSON、字段或幂等键非法 |
| `401` | Bearer Token 缺失或不匹配 |
| `404` | 未知 endpoint |
| `405` | HTTP method 不支持 |
| `413` | 请求体超过限制 |
| `415` | Content-Type 不是 `application/json` |
| `429` | 超过全局速率限制，响应带 `Retry-After` |
| `503` | 会话切换等原因导致 `pi.sendMessage()` 拒绝投递；幂等预留已释放，可重试 |

## 安全说明

- 默认按用户要求监听所有 IPv4 网卡 `0.0.0.0`，所以只要配置 token 就可能被局域网访问；应配合主机防火墙限制来源地址。
- Channel 自身不实现 TLS。公网开放时必须置于 Nginx/Caddy/网关之后，由外层提供 HTTPS、来源 ACL 和更强的限流。
- 不返回 CORS 允许头，浏览器跨域请求默认不会被放行。
- Bearer Token 保护“谁能投递”，不能保证上游内容本身可信。外部正文会明确标记来源，但依然属于模型可见输入，应只给可信系统发放 token。
- 每条可唤醒消息都可能产生模型调用和费用；建议外部告警侧同样做聚合，并始终使用稳定的幂等键。
