# pi-web-extension

在浏览器里打开 Pi：管理**整机**的 Pi 会话，并像 CLI 一样正常使用（聊天、工具调用、图片、审批）。

后端零第三方依赖（仅 `node:http` + SSE），每个打开中的会话对应一个子进程
`pi rpc-entry --mode rpc`（Pi 原生 headless JSON-lines 协议），HTTP/REST 与 SSE
作为“从 CLI 到 Web”的中继。

## 安装与启用

```bash
# 在 pi-codex-replica 仓库内
pi install .
# 使用 --web 自动启动，或用 /web 手动启动
pi --web
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/web` | 启动 HTTP 服务器并打开浏览器 |
| `/web status` | 显示当前 URL / 运行状态 / 已打开会话数 |
| `/web stop` | 停止服务器并关闭所有子进程 |

## Flags / 环境变量

| Flag | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `--web` | `PI_WEB=1` | 关 | session 启动时自动起服务器（不开浏览器） |
| `--web-host` | `PI_WEB_HOST` | `0.0.0.0` | 绑定地址 |
| `--web-port` | `PI_WEB_PORT` | `8600` | 端口；`0` = 随机空闲端口 |
| `--web-token` | `PI_WEB_TOKEN` | 空 | Bearer 令牌；空则不鉴权 |

> 子进程 CLI 路径自发现：`process.argv[1]` 指向 pi 的 `dist/cli.js` 时取同名
> `dist/rpc-entry.js`。非常规安装可用 `PI_WEB_CLI_PATH` 显式指定。

## HTTP API（REST + SSE）

浏览器 UI 依赖这些端点，也可直接复用：

```
GET    /api/sessions                 → 整机会话目录（按 cwd 分组的 SessionInfo）
POST   /api/sessions                 → 打开既有会话(sessionPath)或新建
GET    /api/sessions/:id/events      → SSE 事件流（AgentSessionEvent + exit）
GET    /api/sessions/:id/history     → { state, entries, messages }
POST   /api/sessions/:id/prompt      → 发送消息（text + 可选 images base64）
POST   /api/sessions/:id/steer       → 中断并注入 steering 消息
POST   /api/sessions/:id/follow_up   → follow-up 消息
POST   /api/sessions/:id/abort       → 中止当前 turn
POST   /api/sessions/:id/rename      → 重命名会话
POST   /api/sessions/:id/compact     → 手动压缩
POST   /api/sessions/:id/ui          → 响应 extension_ui_request 审批对话框
DELETE /api/sessions/:id             → 停止子进程
```

`POST /api/sessions` body：`{ sessionPath?: string, cwd?: string }`。
带 `sessionPath` 是**恢复/切换**到既有会话（子进程 `--session <path>`），缺省为新建。
`cwd` 缺省为当前进程 cwd。

## 前端

单文件内嵌 UI（`src/frontend.ts` 模板字符串）：会话侧栏（按项目分组）、消息流、
markdown 渲染、工具调用折叠、图片粘贴显示、审批对话框、SSE 流式。令牌通过
`__PI_WEB_TOKEN__` 占位符在 serve 时注入，可配合反代鉴权。

## 目录结构

```
extensions/web/
  index.ts           扩展入口：注册 /web 命令、flags、session 生命周期
  src/
    config.ts        flag/env → WebServerConfig
    server.ts        HTTP + SSE 服务、路由、子进程生命周期管理
    pi-rpc.ts        PiRpcSession：spawn rpc-entry、JSON-lines 协议、事件转发
    sessionCatalog.ts 整机会话枚举（SessionManager.listAll + 目录扫描兜底）
    frontend.ts      内嵌浏览器 UI（模板字符串）
```

## 测试

```bash
npm test                                # 单测（hermetic；smoke 默认跳过）
PI_WEB_CLI_PATH=<pi>/dist/rpc-entry.js \
RUN_WEB_SMOKE=1 npx vitest run extensions/web/src/smoke.test.ts   # 真实机器 E2E
```

smoke 会真实启动 `pi --mode rpc` 子进程并调用模型（`Reply with exactly: OK`），
验证会话列表、UI 服务、RPC 子进程打开/state/history/关闭，以及 prompt 往返的
事件流（`agent_start/turn_start/message_start/turn_end/agent_end/agent_settled`）。

## 已知约束

- 每个打开中的会话 = 一个常驻子进程；`/web stop` 或 session 结束时全部关闭。
- 会话文件很大（本机 3.6GB / 457 个）时 `GET /api/sessions` 首次较慢
  （`SessionManager.listAll` 需解析全部条目）；前端与会话目录服务均有降级路径。
