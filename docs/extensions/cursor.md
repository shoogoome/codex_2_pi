# Cursor 订阅 Provider

`extensions/cursor` 将 Cursor 账号的模型接入 Pi 原生 provider。请求通过 HTTP/2 Connect/protobuf 发送，工具调用通过协议中的 MCP 声明返回给 **Pi 执行**；不启动 `cursor-agent`，也不启动本地 HTTP 代理。

这里的 MCP 是 Cursor Agent 协议的自定义工具字段，并非要求另外安装/连接 MCP 服务器。扩展直接把 Pi 工具 schema 注入 `AgentService/Run.mcp_tools`，同时提供新版动态目录的内联描述与 MCP 状态查询；收到 `mcpArgs` 后转为 Pi `toolCall`，将 Pi 工具结果回写到同一连接。当前上游是 Agent RPC，不是直接接受 OpenAI `tools` JSON 的标准 chat-completions endpoint。

## 使用

本包根目录已通过 `pi.extensions: ["./extensions"]` 自动发现该扩展。安装本包并重启 Pi（或 `/reload`）后：

```text
/login cursor
/cursor refresh
/model cursor
```

- `/login cursor`：打开 Cursor 浏览器认证，PKCE 轮询可取消。返回的 OAuth 凭据由 Pi 自己保存/刷新；扩展不直接读写 `auth.json`。
- `/cursor status`：查看协议核心版本、端点、模型目录来源和执行边界。
- `/cursor usage`：通过 Pi 解析/刷新当前登录凭据，查询官方 DashboardService 的本期用量：计费周期（UTC）、套餐百分比与 Auto/API 分类、套餐/按量消费和服务端公开的个人/团队额度。金额为 USD（服务端 cents 转换），缺失数据标记为“未提供”，不推断无限额度、Pro 套餐或按量开关状态。查询支持取消，10 秒超时，会话关闭会终止请求；不读取浏览器 Cookie，也不额外保存账单数据，不改变 Pi 的 token/cost 估算。
- `/cursor models`：显示当前注册模型；启动时先同步恢复最近一次发现的原始目录缓存（`cached`），在 Pi 恢复会话模型之前注册动态型号和完整路由参数。无缓存、缓存过期或损坏时使用内置元数据（`fallback`）；二者均不表示账号拥有访问权限。
- `/cursor refresh`：使用 Pi 的有效凭据重新发现实时模型。目录请求明确指定 `USER_AVAILABLE` scope，合并 Agent 与 AiService 的账号目录，包含服务端实际公开的 Claude/GPT/Gemini 等模型及无参数默认变体；不会请求管理端全量目录或用静态模型伪造权限。
- `/thinking` 或本包 `/effort`：选择 Cursor 实际公开的推理档位；不根据模型名字擅自开放档位。
- `--cursor=false`：关闭该扩展。

需要 Node **22.19+**、Pi **0.84.3+**。不要同时加载其他注册 `cursor` provider 的第三方扩展，否则会发生覆盖。

## 认证与安全边界

- 默认只使用 Pi 显式登录的 Cursor OAuth 凭据。**不会读取 macOS Keychain、Cursor IDE 数据库、CLI 登录态，也不会自动解锁钥匙串。**
- 自动化可显式设置 `CURSOR_ACCESS_TOKEN`；它是 Cursor access token，不是 OpenAI API key，也不等同于 `CURSOR_API_KEY`。环境变量 token 不具备自动刷新能力。优先使用 `/login cursor`，不要把 token 写进项目文件、命令参数或日志。
- 原生文件读写、Shell、fetch 以及 hosted web/search 自动批准被拒绝。联网或文件操作必须通过 Pi 暴露的工具，适用现有审批、plan-mode 和工具事件。
- 保留完整工具说明；`PI_CURSOR_SLIM_TOOLS=1` 可显式启用上游的工具描述精简。
- 服务端端点限定 Cursor 官方域名（协议核心保留 loopback 开发支持）。`PI_CURSOR_AGENT_URL` 可显式指定账号区域端点；不读取 CLI 配置。不要把凭据交给不可信代理。

## 网络配置

Cursor 协议需要可用的 **HTTP/2**；普通 OpenAI SSE 代理不能替代。可使用 `PI_PROXY_CURSOR`（优先）、`PI_PROXY` 或 `HTTPS_PROXY` 配置 HTTP CONNECT 代理。请求的 provider-scoped `env` 优先于进程环境，端点/代理配置不会通过临时修改 `process.env` 污染其他请求。

`PI_CURSOR_CLIENT_VERSION` 可在协议漂移时显式更新客户端版本标识。模型列表应以实时发现结果为准，修改本地模型元数据不能解锁账号权限。

## 会话与隐私

- 双向连接在工具调用处暂停，Pi 执行后将结果写回同一 Cursor run；连接丢失时根据 Pi 历史重建。
- 每轮始终注入 Pi 当前声明的工具和完整系统提示词，包括首轮问候、致谢、身份询问和确认/续接。已删除上游闲聊分类器及按消息内容清空工具、替换提示词的省 token 逻辑；工具可用性由 Pi 当前工具声明与显式 tool choice 决定，不由 provider 猜测用户意图。
- switch、fork、tree、compaction 会清理本会话的协议状态；shutdown 取消进行中的认证/请求并关闭全部连接，下一次 session_start 可重新使用 provider。
- 协议 checkpoint/blob 仅存内存，**不额外保存第二份对话 journal**；Pi 的正常会话持久化保持不变。
- debug/lifecycle/metric 日志默认关闭。显式启用 `PI_CURSOR_PROVIDER_DEBUG=1` 时（`PI_CURSOR_LIFECYCLE_LOG` 仅指定文件路径），私有日志可能包含提示词、工具参数和返回内容，须按敏感资料管理；不建议日常启用。
- 模型目录缓存仅含元数据，启动恢复不联网、不刷新凭据；修复“手动可选新型号，重启会话却找不到并回退”的时序问题。文本、图片、工具结果发送到 Cursor，仍受其模型路由和数据处理政策约束。

## 限制与验证

`resource_exhausted` 等 Connect 错误会优先显示 Cursor protobuf 详情里的标题与说明；服务端未提供详情时保留原始错误，不擅自判断为额度或上下文问题。明确标为不可重试的错误不会自动重试。模型发现成功不表示订阅额度尚有剩余；套餐/额度限制需在 Cursor 侧处理，扩展不会绕过。

`USER_AVAILABLE` 指定目录查询范围，不保证服务端始终返回所有厂商。排查模型缺失时，应核对 `/cursor refresh` 的实际结果；不能仅凭一次独立目录查询成功，就断言完整 Pi 刷新已修复。当前实连诊断曾观察到独立查询返回 43 个模型族，而完整刷新返回较少目录，差异仍待定位。

协议来自社区逆向实现，不是 Cursor 官方稳定的通用 LLM API。端点、protobuf schema、账号地区、模型权限和套餐策略可能变化。订阅额度/按量费用仍由 Cursor 控制，Pi 显示的 usage/cost 可能是估算，不是账单。

支持的采样/输出参数受 Cursor 协议限制；不支持的参数会报错，不保证 `maxTokens` 等参数与 OpenAI API 等价。自定义 `fetch` 不适用于 HTTP/2，会明确拒绝；`onPayload`、`onResponse` 与取消信号有本地适配。

本仓库使用假凭据和离线 transport fixture 验证 OAuth、流、Pi 工具闭环及安全拒绝；这不能代替真实账号测试。首次登录后建议依次验证：短文本 → 文件读取工具 → 受审批保护的写工具 → Esc 取消 → `/fork`/压缩/恢复。不会自动发起收费的实连请求。

协议核心固定自 `@rahularya01/pi-cursor@1.4.38`，保留 MIT 许可；来源与本地差异见 [`vendor/README.md`](../../extensions/cursor/vendor/README.md)。
