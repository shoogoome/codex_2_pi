# Pi Codex Replica

一个独立的 Pi 包，用于在不修改 Pi 核心的情况下复刻部分 Codex CLI 能力。

## Pi 1.2 兼容

- 支持 `before_agent_start` 的 user/custom 两类运行，并保留旧版无 `messageType` 事件的行为。
- 后台通知不会解除用户中止后的异步任务唤醒抑制，也不会消耗 `/agents use` 为下一次用户发话预留的角色提示。
- 后台运行仍注入通用工作准则、只读规划限制及必要上下文；memory 不把后台通知当作用户提示检索记忆。
- 内置主题使用 `https://pi.dev/schemas/theme.schema.json`，符合 1.2 启动时的严格校验。

## 包含的扩展

完整能力总表、分组与详情链接见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)；下表列出当前全部扩展。

### 基础扩展（Codex 复刻）

| 扩展 | 能力 | 主要命令 / 工具 |
|---|---|---|
| `extensions/diff` | 展示 Git 变更；按会话逐文件审阅，确认后隐藏、再次修改重现。 | `/diff` · `/changes` · `Ctrl+R` |
| `extensions/review` | 提供 Codex 风格的评审预设（基准分支 / 未提交 / 某提交 / 自定义）。 | `/review [instructions]` |
| `extensions/user-input` | 向用户提问 1-3 个带选项的问题（UI 自动加 `Other` 自由文本项）。 | `request_user_input` / `ask_user_question` / `askUserQuestion` |
| `extensions/side` | 在 Pi overlay 中继承当前 leaf 上下文进行独立、无工具的临时对话，关闭窗口即丢弃 side 历史。 | `/side [message]` |
| `extensions/init` | 通过主 agent 检查项目并创建项目 `AGENTS.md` 指南（已存在则跳过）。 | `/init` |
| `extensions/imagegen` | Codex 订阅生图：复刻 codex 内置 `image_gen.imagegen`，走 openai-codex OAuth 直连 ChatGPT 图片 API（gpt-image-2），生成/编辑结果保存到 `~/.pi/agent/generated_images/<session>/` 并回传给模型检查迭代。 | `generate_image` |
| `extensions/todo` | Codex 风格 `update_plan`（整份计划快照）+ 计划渲染 + 常驻 plan overlay。 | `update_plan` |
| `extensions/openspec-progress` | 从当前 session branch 最后一次 `/opsx-apply <change>` 读取 `tasks.md`，在输入框上方显示 OpenSpec 完成进度，支持详情 overlay。 | `Alt+O` · `/opsx-progress on\|off\|toggle\|<change>` |
| `extensions/effort` | 通用 thinking 档位、Codex 风格两级高级选择器、`/model` 模型+档位原子选择，以及 `Alt+,` / `Alt+.` 升降快捷键。 | `/effort [status\|off\|minimal\|low\|medium\|high\|xhigh\|max\|ultra]` · `/model` |
| `extensions/fast-mode` | Codex Fast / UltraFast 路由：订阅 OAuth 请求注入 `priority` 或 `ultrafast`，路由字段前置，互斥并保存会话状态；切换影响下一次请求，不改变正在输出的响应；UltraFast 支持 GPT 模型，需 Pro $500 或符合条件的 Enterprise/Edu，Pro $200 不支持。 | `/fast [on\|off\|status]` · `/ultrafast [on\|off\|status]` · `--fast` / `--ultrafast` · settings `"fastMode": "fast"` |
| `extensions/ultra` | GPT-5.6 Sol/Terra 的 Codex Ultra controller：会话态 `ultra`、wire `max`，自动激活 `task_agent` 并注入并行 multi-agent workflow。 | 由 `/effort ultra` 或 `/model` 高级选择器进入 |
| `extensions/compact-ui` | Codex 风格紧凑 UI:消息前缀化 + 常见内置工具短渲染（与 claude-ui 互斥）。 | （`--claude-ui=false` 回退到此皮肤） |
| `extensions/pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `extensions/goal` | Codex 风格 thread goal:持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | `get_goal` / `create_goal` / `update_goal` · `/goal <objective>` · `/goal resume` |
| `extensions/localagent` | 注册 `task_agent` + `local_agent` 任务类型：默认从当前活动分支的有效上下文精简 fork 后台子 agent（精确继承 provider/model/thinking），传 `team_name`+`name` 可改为创建长生命周期 teammate。 | `task_agent` |
| `extensions/localshell` | 注册 `task_bash` 工具 + LocalShellTask：前台完成只保留一条 Bash 工具结果，超时转后台；Esc 可中断前台命令及启动前的审阅基线等待，审阅收尾不阻塞命令返回；后台终态默认在空闲时即时、忙时于 agent_end 安全边界更新 TUI，不打断/注入 LLM，调用头、输出 gutter、颜色和折叠与 Claude UI 的 `Bash` 一致。 | `task_bash` · `task_status` / `task_kill` · `PI_TASK_BASH_TIMEOUT_MS` 调默认超时 · `PI_TASKS_WAKE_ON_BACKGROUND=1` 可恢复 Claude 式主动唤醒 |
| `extensions/tasks` | 任务框架底座:default TaskStore + 背景 agents panel（Ctrl+Y 焦点 / Enter overlay）+ 任务查询管理工具。 | `task_status` / `task_kill` / `task_list` |
| `extensions/teammate` | 长生命周期多 agent 团队协作：完整 `name@team` 隔离、自动结果回传、持久消息重放、硬写审批、共享任务看板与安全 resume。 | `team_create` / `task_agent(team_name+name)` / `send_message` / `request_plan_approval` / `team_delete` / `team_plan_approve` |

### 新增扩展（Codex + Claude Code 能力移植）

| 扩展 | 能力 | 主要命令 / 入口 |
|---|---|---|
| `extensions/claude-ui` | Claude Code 风格无边框 TUI 皮肤:● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· `Ctrl+O` 展开 |
| `extensions/input-history` | 跨会话输入历史持久化 + 反向增量搜索。 | `Alt+R`（可改绑 `ctrl+r`） |
| `extensions/session-summary` | 输入框上方标题为 `summary`、框内全灰色的可滚动摘要：用户输入和完整 Agent run 各一行，模型、展示条数及最近 N 轮上下文共存于全局 `settings.json`。 | `/session-summary context <0-20>` · `/session-summary model <provider/model>` · `Alt+↑/↓` |
| `extensions/context-viewer` | 只读查看当前有效系统提示词和隐藏注入上下文，不含聊天历史。 | `/context` · `/system-prompt` · [详情](docs/extensions/context-viewer.md) |
| `extensions/context-pipeline` | 分层上下文管理：按预算截断 tool_result、microcompact 清旧结果（默认手动，保护 prompt 缓存），并为 Pi 原生压缩生成结构化摘要。 | `/prune [status\|soft\|hard]` · `/context-prune` · `--prune-auto` / `PI_CTXPIPE_PRUNE_MODE=auto` 开自动 prune |
| `extensions/compact-continue` | Pi 阈值压缩后保守判断是否仍有工作：仅在 toolResult、截断/tool-use 回合或未完成计划等强信号下隐藏续跑一次，并让真实用户/自动队列优先。 | `--compact-continue`（默认开）· `--compact-continue=false` 关闭 |
| `extensions/agents-context` | 补充加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· `PI_AGENTS_CONTEXT=0` |
| `extensions/settings-env` | 从全局和项目 `settings.json` 的顶层 `env` 读取变量并注入 Pi 进程；已有环境默认优先。 | `env` · `envOverride` |
| `extensions/channel` | 多 Channel 通信中心：管理 HTTP/微信、本机 Pi 双人/群频道，以及 MCP 会话服务与原生 dots Events 桥接；模型可自然语言管理并发送协作消息。保留外部通信方向与旧 `PI_CHANNEL_*` 兼容。 | `/channel` 面板 · `channel_manage` · `channel_send` · `/channel status\|restart\|auth\|login\|send` |
| `extensions/memory` | Claude Code 风格自动长期记忆：按当前模型窗口动态限额，全局 `memory.contextRatio` 设置占比（默认 2%），限制累计注入；按需提炼，支持备份去重目录并收拢会话已注入记忆。 | `/memory [list\|show\|init\|compact]` · `/memory-compact` · `/remember <text>` |
| `extensions/approvals` | 唯一审批闸门:权限模式 × 规则库 × 命令安全 × 受保护路径 × MCP 逐工具，统一 allow/ask/deny。 | `/approvals [mode\|rules\|allow\|ask\|deny\|remove]` |
| `extensions/plan-mode` | 只读规划闸门:仅可探查，模型提交计划经批准后才恢复写工具。 | `/plan [on\|off]` · `Alt+P` · `exit_plan_mode` |
| `extensions/behavior` | 向系统提示词追加「工作准则」：Codex 式自主性 + Claude Code 式工程规则（默认开）。 | `--behavior=false` · `PI_BEHAVIOR=0` |
| `extensions/profiles` | 命名配置预设（模型+工具+thinking+审批）一键保存/切换/删除。 | `/profile [save\|apply\|delete\|<name>]` · `--profile <name>` |
| `extensions/resume-picker` | 会话恢复选择器 + 跨项目会话全文检索（rg），命中后切回历史会话。 | `/resume-picker [--all] [过滤词]` · `/search <关键词>` |
| `extensions/autopilot` | 自主续跑控制器:自动注入隐藏 follow-up 连续推进，按预算/轮数/收益递减停止。 | `/autopilot [on [目标]\|off\|status]` |
| `extensions/loop` | Claude Code 风格定时循环：立即执行一次提示词，之后在 agent 空闲时按间隔重复；会话内生效并自动过期。 | `/loop [interval] <prompt>` · `/loop list` · `/loop cancel <id\|all>` |
| `extensions/cursor` | Cursor 订阅原生 provider：显式 OAuth、实时模型发现、HTTP/2 协议与 Pi 工具执行闭环；不读取 Keychain/IDE 登录态。 | `/login cursor` · `/model cursor` · `/cursor [status\|models\|refresh\|usage]` · [详情](docs/extensions/cursor.md) |
| `extensions/local-models` | 发现本地大模型运行时（Ollama、LM Studio）并注册为 localhost OpenAI 兼容 provider。 | `/local-models [list\|pull\|ensure_ready]` · `/ollama` · `/lm` |
| `extensions/codebuddy-reasoning` | 清理 CodeBuddy 网关不支持的旧请求字段；原样透传 Pi 系统提示和工具声明，兼容 DeepSeek 等模型的结构化工具调用。 | （无命令，自动生效） |
| `extensions/webfetch` | 联网抓取 + 网络搜索（移植 Claude WebFetch，搜索对齐 Codex `web.run`）:URL→fetch→HTML 转 markdown;或 `query`→DeepSeek Search 返回排序结果并可 `source: "S3"` 重开;本地正文为空/SPA 空壳时用 DeepSeek Fetch 服务端渲染兜底。SSRF 防护(私有段+连接前 DNS 守卫)、10MB 流式截断、搜索/页面双缓存(按次计费)。 | 工具 `webfetch` · `/webfetch [status\|reload]` · `--webfetch`（默认开） · `DEEPSEEK_API_KEY` |
| `extensions/mcp` | 内置 MCP 客户端:读 `.pi/mcp.json` 连 server，暴露 `mcp__<server>__<tool>`，审批由 approvals 兜底。 | `/mcp [list\|status\|add\|remove\|reconnect]` |
| `extensions/plugin-loader` | Claude 风格插件管理器：Marketplace、安装/更新/卸载、user/project/local scope，并接入 skills/commands/themes/styles/hooks/agents/MCP；MCP URL 支持 `${ENV_VAR}`，单个服务器配置/注册失败不阻断其他服务器和资源加载。 | `/plugin` · `/plugin marketplace …` · `/plugin install\|remove\|update …` |
| `extensions/hooks-runner` | 配置驱动 hook 框架:把 Pi 生命周期事件桥接到 Claude Code JSON hook 协议，可拦截/改写/注入。 | `/hooks` · `.pi/hooks.json` |
| `extensions/agents` | 加载 Claude 风格 subagent 角色 `.md` + 内置角色库，应用到当前会话（收敛工具 + 注入系统提示）。 | `/agents [list\|show <name>\|use <name>]` |
| `extensions/migrate` | 一次性把 Claude/Cursor 的 MCP、subagents、commands、hooks、memory 导入 `.pi/`，只导缺失不覆盖。 | `/migrate [category]` · `--dry-run` |
| `extensions/monitor` | 只读效果监控:缓存命中率、上下文构成、清理/压缩回收比，面板 + footer 展示。 | `/monitor` |
| `extensions/token-speed` | 底部展示 token 生成速度(tok/s):流式实时估算 + 每条响应精确测量，含 TTFT、会话加权平均与最近序列。 | `/speed` · `/speed on\|off\|status` · `--token-speed=false` |
| `extensions/cost-usage` | 只读追踪会话美元成本、按模型 token、时长与编辑增删行，并在 OAuth 模式查看 Codex 订阅套餐额度与重置时间。 | `/cost` · `/usage` |
| `extensions/web` | 浏览器 Web UI：管理整机 `~/.pi/agent/sessions` 的 Pi 会话并从 CLI 到 Web 聊天；后端零依赖 HTTP + SSE，每个会话一个 `pi --mode rpc` 子进程，支持流式事件/工具调用/图片/审批对话框。 | `/web` · `/web status\|stop` · `--web` / `--web-host` / `--web-port` / `--web-token` |
| `extensions/honeypot` | LLM 攻防蜜罐实验：同步 jailbreak-prompts、DecoyPot/CTF 场景、NERV 风格蓝队检测与 prompt-manager 清单导出（授权红队评测）。 | `/honeypot` · `--honeypot=true` · [详情](docs/extensions/honeypot.md) |

### CodeBuddy 工具调用兼容性与实测

`codebuddy-reasoning` 使用 `index.ts` 源码入口和 Pi 主进程的 `/compat` API，不能改回 `dist/index.js`：原生 JS 加载可能绕过 Pi 的依赖别名，落到工作区旧版 `pi-ai`，使新版系统提示和工具声明丢失。

可运行 `python3 extensions/codebuddy-reasoning/fixtures/liveAcceptance.py` 做真实验收（需要已有 CodeBuddy 配置，会产生模型调用费用）。脚本启动独立 Pi，分别测试 `read`、`codemode → read` 和当前已配置扩展的加载方式，读取临时随机标记并验证工具执行事件；不打印凭据或原始请求。用 `--case direct|codemode|configured|configured-codemode` 可单独测试，模型可通过 `PI_ACCEPTANCE_PROVIDER` / `PI_ACCEPTANCE_MODEL` 覆盖。

## Named Channels（HTTP + 微信 ClawBot + MCP 服务 + dots + 本机 Pi）

多个独立 Pi 开发同一项目的不同模块时，可在 `/channel` 创建 **Pi 双人/群频道**，用配对码加入并填写各自的工作介绍。首版支持 **macOS/Linux、同机器同 OS 用户**，通过私有 Unix socket 通信；双人最多 2 人，群最多 32 人（含创建者）。

- **自然语言操作**：`channel_manage` 支持全部现有协议（`http` / `wechat` / `mcp` / `dots` / `pi`）。可创建 HTTP/微信/MCP/dots 频道、查看脱敏状态、修改配置、挂载/卸载、启停、重启及确认删除；微信支持扫码认证，Pi 频道继续支持配对加入、成员职责、本人介绍和确认销毁。用 `channel_send` 发送消息与阶段成果。
- **会话恢复生命周期**：创建者进程负责转发；显式销毁才删除状态。会话关闭、`/new`、`/reload` 或进程重启会把操作状态写入当前 session JSONL，恢复同一 session 时重建固定频道并自动重连，不新增 Channel 配置文件。打开面板、编辑外部配置及 `/channel restart` 不影响 Pi 频道。
- **配对与身份**：邀请默认 30 分钟有效，可刷新/撤销；码会进入创建/显式查看的工具结果和当前会话，勿发送到无关频道。成员有独立 ID、会话/cwd 与工作职责，不会因同项目自动加入。
- **可控投递**：业务消息使用 `steer`，空闲自动唤醒；不强制中止工具，不自动回传 assistant 文本。成员事件不单独唤醒。Pi 消息介入 HTTP/微信/MCP 回合时停止该混合回合的自动回复，外发需显式选目标。
- **真实回执**：逐成员区分已入队、失败、未知，入队不等于已处理；同 ID/正文在 10 分钟内重试仅查询结果，不重播。正文最多 64 KiB，每成员每分钟 30 条，每接收者 100 条待确认；重启期间不补投离线消息，仅恢复频道连接。

### HTTP / 微信持久化频道

例如 `channel_manage(action="create", protocol="http", name="dot-http", direction="both", http={callbackUrl:"http://127.0.0.1:14318/pi/replies"})` 可直接创建并挂载双向 HTTP Channel；入站 token 未提供时自动生成，仅在创建结果显示。HTTP 出站必须提供 `callbackUrl`。微信用 `protocol="wechat"` 创建后，再调用 `channel_manage(action="auth", channel="频道名")` 获取二维码并由用户扫码。`list` / `status` 不返回 token。配置保存成功不等于传输已就绪，应检查返回的运行时状态，尤其是 `error`。

执行 `/channel auth`（`/channel login` 是兼容别名）会打开通用认证目标选择器：选择已有 Channel，或选择某个支持认证的协议来新建 Channel。当前首个认证适配器是微信 ClawBot，选中后扫码即可；后续 OAuth、设备码等协议可注册自己的认证适配器，不会把 `login` 固定等同于微信。也可执行 `/channel` 打开类似 `/plugin` 的配置面板，在列表按 `l` 打开同一通用认证选择器。

- **作用域**：默认多会话（在各会话面板按 `m` 挂载），也可选全部会话；旧单会话配置自动迁移为多会话挂载。
- **方向**：每个 Pi 会话可分别设置对端 → Pi、Pi → 对端或双向；微信只由一个会话长轮询，再把入站消息分发给所有允许入站的挂载会话，所有允许出站的会话都可共享发送。
- **协议**：HTTP 入站 listener + 出站 callback；微信 iLink/ClawBot 扫码登录、文本收发、图片入站分析，以及本地图片加密上传发送（JPEG/PNG/GIF/WebP，最多 10 MiB）。用 `channel_send(channel="wx", image_path="output/chart.png", content="可选说明")` 发图（图片先发送，说明单独一条；iLink 不支持图文混合 item）；相对路径按当前项目解析，自动回复和 `/channel send` 仍仅发送文本。
- **名称路由**：Pi 每轮感知已挂载 Channel 名称；用户从微信要求“给 `产物群` 发送阶段结果”时，Pi 可调用 `channel_send(channel="产物群", ...)`。

原有环境变量配置保持兼容：设置 `PI_CHANNEL_TOKEN` 仍会得到只读的 `legacy-http` 入站 Channel，默认监听 `0.0.0.0:4317`。HTTP 入站继续使用 `POST /v1/messages`、Bearer 鉴权、幂等和限流：

```bash
curl "http://<机器IP>:4317/v1/messages" \
  -H "Authorization: Bearer $PI_CHANNEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"alertmanager","content":"生产环境出现告警，请检查"}'
```

HTTP/微信/MCP/dots 配置保存在私有文件 `~/.pi/agent/channel/config.json`（`0600`）；微信凭证按 Channel 隔离保存。Pi 频道状态写入当前 session JSONL，不写入该配置文件。完整面板操作、协议字段、安全限制及扫码流程见 [`docs/extensions/channel.md`](docs/extensions/channel.md)。

### 将当前会话暴露为 MCP 服务

调用 `channel_manage(action="create", protocol="mcp", name="我的会话")`，或在 `/channel` 面板选择新增 MCP 类型。默认创建仅挂载当前会话的 `selected` Channel，监听 `127.0.0.1:0` 并自动生成 token；创建结果提供 `listenerToken` 和 `mcpClientConfig`（实际 `/mcp` URL 与 Bearer header），`list` / `status` 不返回 token。MCP 不支持 `scope="all"`。鉴权可选：创建时传 `mcp:{auth:"none"}` 或在面板关闭 **MCP auth**，则仅返回 URL，无需 token/header；默认仍为 `bearer`。

这是基于官方 SDK 的 **Streamable HTTP 服务端**，不是 `/mcp` 所管理的外部 MCP 客户端。连接方使用 `pi_send_message({content,id?})` 异步投递，再用 `pi_read_replies({after,limit?})` 读取本 Channel 的回复；`pi_session_info` 只提供会话名称、ID 和能力。不直接开放会话历史、cwd 或 read/bash 等底层工具。入队不等于处理完成，`channel_send` 写入回复信箱也不等于客户端已读；获准连接的客户端共享该信箱（免鉴权时为任何可连接者）。

回复信箱仅在内存中保留最多 100 条、总计 1 MiB，单条最多 64 KiB；重启、停用/卸载、`/reload`、关闭会话或保存外部 Channel 配置导致的传输重启都会丢失未读回复。客户端应检查 `instanceId`，变化后丢弃旧游标。服务依赖当前 Pi 进程存活，不是独立后台服务。

默认 `/mcp` 请求要求 Bearer token，可显式设 `mcp.auth:"none"` 关闭；免鉴权意味着任何能连接端点的人都可使用会话服务。两种模式都拒绝带 `Origin` 的浏览器请求并校验 Host；公网接入需用户授权的 TLS 反代和来源 ACL，不自动提供域名或 OAuth。Bearer 模式客户端须能发送自定义 header，免鉴权模式只需 URL；ChatGPT/dot 能否使用该连接仍需实测。详见 [MCP 会话服务](docs/extensions/channel.md#mcp-会话服务)。


### Pi ↔ dots 原生 Channel

`channel_manage(action="create", protocol="dots", name="我的 dot")`，或在 `/channel` 新增 **dots · MCP Events**。这是独立于普通 `mcp` 的 Channel 类型：dot 使用 MCP 工具给当前 Pi 会话发消息；Pi 用 `channel_send` 发消息时，为已存在订阅持久排队 `pi.message.created`，通过 Standard Webhooks 签名回调通知现有 ChatGPT dot。支持 MCP 2.0 Events 发现、订阅/退订、challenge 验证、私有订阅/outbox 持久化、有界重试/死信、跨重启恢复与 callback SSRF 防护。

默认本机随机端口、Bearer 鉴权、`selected + both + followUp + wake=true`；不自动创建公网入口或 OAuth。显式 `dots:{auth:"none"}` 可用于 ChatGPT 无认证联调（包括事件订阅），但所有可达者共享此 Channel，不能视为身份验证或生产安全隔离。MCP 手工回复信箱仍是内存，Webhook 2xx 只代表平台接收，不证明 dot 已被唤醒；真实订阅及停止轮询后的唤醒需单独验收。不会自动接通或发送微信。已支持固定账户网关＋成熟 AS OAuth：本机一次保存账户连接后，新建/恢复 dots Channel 自动共用同一 ChatGPT 连接；用户可显式订阅整个专用 dots 集合（含未来 Channel），无需逐 Channel 重配插件。真实首次 OAuth/刷新/后台唤醒须用户验收，见 [账户入口与首次绑定](docs/extensions/dots-account-bridge.md)。传输配置详见 [dots Channel](docs/extensions/dots.md)。

## 命令

### `/diff`

显示当前 git 工作树 diff，包括未跟踪文件。在非 git 仓库中会显示：

```text
`/diff` — _not inside a git repository_
```

### `/changes` · `Ctrl+R`

在对话界面打开当前会话的 Git 文件审阅面板：选择文件查看相对 HEAD 的完整差异（含暂存、未暂存和新增文件），按 `d` **确认完成**后隐藏当前版本；文件再次变化会重新出现。确认不会暂存、提交或还原文件，也不会唤醒模型。

覆盖本会话的直接编辑、Shell、后台任务和子 Agent；未被本会话改变的初始脏文件不自动纳入。即使历史会话当前 cwd 不在 Git 仓库，只要后续操作触及其他 Git 仓库，也可在跨目录模式查看。按 `v` 选择 diff 行，`s/m` 可发送到 side/主会话，`e` 可编辑文件；`o` 在当前 Git、当前目录和跨目录仓库模式间切换。跨目录模式聚合会话操作窗口触及的其他 Git 工作树。保留选择器内原有 Ctrl+R 重命名行为。快捷键可用 `--changes-key alt+v` 改绑，`--changes-key=''` 禁用。

支持 Vim 导航：`j/k` 移动、`h/l` 切栏、`H/M/L` 顶中底、`B` 上页、`gg/G` 首尾、`Ctrl+u/d` 半页、`Ctrl+b/f` 翻页、`q` 关闭，以及 `5j` / `10gg` 次数前缀。

完整操作、会话恢复、并发归因限制和故障处理见 [会话 Git 审阅](docs/extensions/session-git-review.md)。

### `/review`

在当前本地 Git 工作树中启动 Codex 风格 Review，交互选择以下目标：

- 对比基准分支进行评审（等价于本地 checkout 后的 PR diff）
- 评审未提交变更（staged、unstaged 和 untracked）
- 评审某个提交
- 自定义评审指令

Review 只读取当前工作树，不直接连接 GitHub，也不会自动读取或评论远程 PR。要评审 GitHub PR，请先将 PR checkout 到本地，再选择对应的 base branch。

### `/review <instructions>`

直接向 agent 发送自定义评审指令，不打开预设选择器。

## 多 Agent 工具

当前多 Agent 实现统一由 `extensions/localagent`、`extensions/tasks` 和 `extensions/teammate` 提供；旧的 RPC `extensions/subagents` 链路已经移除。

### `task_agent`、fork 与 teammate

`extensions/localagent` 的 `task_agent` 有两条路径：

- **fork（默认）**：省略 `team_name`/`name`，从当前持久 Pi session 的活动分支精简 fork，并固定在后台运行。只继承最新压缩摘要、`firstKeptEntryId` 起的保留消息与后续消息；尚未压缩时继承活动分支。不复制其他分支、已被摘要替代的旧历史、统计快照或任务进度日志，父会话保持原样。参数只有 `description`、`prompt` 和可选 `cwd`。
- **长生命周期 teammate**：同时传 `team_name` 和 `name`，把成员加入已有 team（需先 `team_create`）。此时可用 `subagent_type` 选择 role（默认 `general-purpose`）。两个参数必须成对出现，只传其一会明确报错而非静默 fork。

fork 子会话精确继承启动时主会话的 provider、model 对象和 thinking level，不做别名查找，也不允许显式覆盖。Fast/UltraFast（包含关闭）通过主会话的有效状态读取器在每次请求时动态跟随，不依赖历史条目是否被压缩，也不受子 cwd 的默认值影响；仍遵守 Codex OAuth/模型适用条件。LocalAgent 是叶子 worker：继承当前活动工具，但始终剔除 `task_agent` 和 `team_create`，并在工具调用层阻止创建 fork、teammate 或 team；该边界不依赖容易被压缩掉的提示词。它只额外初始化 worker 专属请求/工具钩子，不触发主会话团队协调器等完整启动流程，也不承诺任意第三方扩展配置完全一致。任务会等待 SDK 的自动重试、压缩恢复及续跑全部结束，再根据最终结果发送一次终态通知；中途可恢复的错误不会把最终成功误报为失败。有界最终回答自动送回主会话，完整轨迹保存在 `output_file`。子会话结束或被 kill 后会释放 SDK 运行时引用；通知或输出清理失败会记录日志，不阻断运行时回收，避免终态任务持续持有历史。此优化不自动裁剪父 JSONL，也不保证任意大小的活动上下文都不会耗尽内存。

teammate 成员拥有独立持久 session，可在多轮消息间 idle，并在根 session 恢复时重建。成员用完整 `name@team` 路由：裸名称只有在 team 内（leader 侧则要求跨 team 唯一）才解析，广播也不会越 team。每轮最终回答和错误会自动注入 leader；成员间消息以 `message_sent → message_ack` 持久化，未 ACK 消息在 resume 后按序重放。写文件、变更 shell 和 MCP 调用由运行时硬门禁拦截，只有 `request_plan_approval` 获批后才在当前 turn 开放；恢复时若原 role 被删除或定义指纹变化则 fail-closed。`session_shutdown` 会挂起成员供下一会话重建；显式 `team_delete` 才执行 shutdown handshake 和超时强制清理。详见 [多 Agent 说明](docs/extensions/multi-agent.md)。

根会话容量由 localagent 与 teammate 共用：默认最多 6 个驻留线程、4 个同时执行线程（都包含 leader，即最多 5 个驻留/3 个执行中的子 Agent）；可通过 `PI_AGENT_MAX_THREADS` 和 `PI_AGENT_MAX_CONCURRENT` 调整。teammate 仅在实际 turn 占执行槽，idle 时只占驻留槽；超过执行上限的工作按 FIFO 等待，完成、失败、kill 和 session 切换都会释放或重置配额。

## `/effort` 与 Codex Ultra

`/effort` 不带参数时打开当前模型的推理档位选择器，`/effort status` 查看有效档位；普通档位调用 Pi 原生 thinking level。与 Codex 一样，Max/Ultra 收在第二层 `More reasoning…` 高级选择器中，`Alt+,` / `Alt+.` 可降低/提高普通档位，但提高操作不会静默跨入 Max/Ultra。交互式 `/model [过滤词]` 也会按“模型 → 推理档位”原子选择，取消档位选择不会先切模型。

Ultra 的入口属于 reasoning effort，但实现独立放在 `extensions/ultra`：仅对 `openai-codex/gpt-5.6-sol` / `gpt-5.6-terra` 开放；会话中保留客户端态 `ultra`，provider 请求发送原生 `max`。启用时 controller 会自动激活已注册的 `task_agent`，同时注入 Codex proactive policy 和明确工作流：存在至少两个独立工作流时并行委派，leader 同时推进独立工作，等待自动终态通知后综合；简单任务不强行并行。Plan 模式下 workflow 暂停且不会绕过只读边界，退出后恢复；关闭 Ultra 时只撤销 Ultra 自己激活的 tool。footer/status 会显示 workflow active 或暂停原因。

## `/side`

`/side [message]` 打开 Codex 风格的临时 side conversation。它在 Pi 原生 overlay 中使用当前主模型发起独立、无工具的临时对话；关闭 overlay（Esc 或 Ctrl+C）会中止请求并丢弃 side 历史，主会话不会切换，也不会收到 side 的历史。

这个实现复刻 Codex `/side` 的上下文隔离语义：继承当前 leaf 的上下文作为参考，并在父历史之后、side 消息之前插入隐藏的 user-role boundary，配合独立的 side 系统指令。与 Codex 的完整 fork 线程不同，这里的 side 不提供工具或自动执行循环：每个问题直接基于已有上下文给出完整回答，支持用户继续追问；需要读文件、运行检查或修改的请求应回到主会话。继承上下文通过 Pi 原生 `buildSessionContext` 重建，遵守已有 compaction 边界，并复用发送前裁剪/LLM 可见性规则；进入独立 side 请求前会移除父线程专属的 encrypted reasoning 与 Responses item ID。若仍接近模型窗口，会优先丢弃最旧的完整 turn；服务端确认 overflow 时再以半窗口预算自动重试一次。它不使用系统新终端窗口或 tmux split。

## `/init`

`/init` 复刻 Codex 针对项目指南文件的行为。如果当前目录已经存在 `AGENTS.md`，该命令会跳过以避免覆盖。如果不存在，它会向主 agent 发送提示，请主 agent 检查项目并创建一份简洁的 `AGENTS.md`，内容包括仓库结构、常用命令、编码约定和安全注意事项。

Pi 也支持 `.pi/SYSTEM.md` 和 `APPEND_SYSTEM.md`，但 `/init` 有意以 `AGENTS.md` 为目标，因为 Pi 会将它作为项目上下文文件加载。

## 用户输入工具

此包注册了三个等价的工具名：

- `request_user_input`
- `ask_user_question`
- `askUserQuestion`

每个工具接受 1 到 3 个问题。每个问题包含 `id`、`header`、`question` 和选项列表。UI 会自动添加一个 `Other` 选项，用于自由文本输入。

工具响应格式如下：

```json
{
  "answers": {
    "next_step": {
      "answers": ["Build MVP (Recommended)"]
    }
  }
}
```

## Imagegen 生图（Codex 订阅）

`extensions/imagegen` 是 codex 内置 `image_gen.imagegen` 工具的 pi 移植（参考 `codex/codex-rs/ext/image-generation`）。它复用 pi 已有的 openai-codex ChatGPT 订阅 OAuth 凭证，直连官方图片 API，无需 API key、无需 models.json 里的 image provider 配置：

- `POST https://chatgpt.com/backend-api/codex/images/generations` 生成；`POST …/images/edits` 编辑（JSON body + data URL 图片，非 multipart）
- 模型固定 `gpt-image-2`，`background`/`quality`/`size` 全部 `auto`（与 codex 内置工具一致，不暴露旋钮）
- 参数：`prompt`；编辑时二选一传 `referenced_image_paths`（本地图片绝对路径，≤5）或 `num_last_images_to_include`（最近会话图片 1-5）
- 认证：通过 `ctx.modelRegistry` 找 openai-codex 模型并走 `getApiKeyAndHeaders` 取 OAuth token；API key 模式会明确报错

`generate_image` 会把结果保存到 `~/.pi/agent/generated_images/<sessionId>/<toolCallId>.png`（codex 的 `$CODEX_HOME/generated_images/<thread>/<call>.png` 布局），同时把图片作为 image content block 返回给模型以便检查与迭代（codex 同款行为；当前模型不支持图片输入时 pi 会自动降级为文本提示）。两个开关：

- `--imagegen=false`：整体禁用该工具
- `--imagegen-return-image=false`：不把图片回传模型（省上下文），只返回保存路径，模型可用 read 工具查看图片

注意：生图通常需要 20 秒到几分钟，工具内置 300s 超时与 5s 进度更新。

## OpenSpec Apply 进度

`extensions/openspec-progress` 会回放当前 session branch 的用户消息，使用最后一次 `/opsx-apply <change>` 绑定对应的 `openspec/changes/<change>/tasks.md`。有效任务存在时，输入框上方显示固定高度摘要：

```text
OpenSpec: demo-change · 3/8 · ████░░░░ · Alt+O 切换 · Alt+Enter 查看
当前：2.1 实现进度渲染
```

- `Alt+O`：显示/隐藏摘要；也可用 `/opsx-progress on|off|toggle`
- 摘要显示后按 `Alt+Enter`：打开任务详情；`Esc`：关闭详情
- 任务很多时详情窗口固定高度，使用 `↑/↓` 滚动并显示隐藏数量
- `/opsx-progress <change>`：手动绑定 change
- 未找到当前 branch 的 `/opsx-apply` 或任务文件无有效 checkbox 时隐藏面板，不会触发模型轮次
- `Alt+O` 避开终端 `Ctrl+S` 的 XOFF 行为；也可直接使用 `/opsx-progress` 命令

## Codex Todo / `update_plan`

`extensions/todo` 复刻 Codex CLI 的核心 todo 能力：模型调用 `update_plan`，传入当前完整计划快照，而不是对单个任务做 CRUD。一次调用可以同时新增、删除、重排多个步骤并批量更新状态。

工具参数：

```ts
{
  explanation?: string;
  plan: Array<{
    step: string;
    status: "pending" | "in_progress" | "completed";
  }>;
}
```

工具成功时只向模型返回 `Plan updated`。Pi TUI 会把计划渲染成 Codex 风格 checklist，并在输入框上方显示常驻 overlay：

```text
● Plan (2/4)
├─ ✓ Inspect Codex source
├─ ✓ Design Pi extension
├─ ◐ Implement update_plan
└─ ○ Run verification
```

最新计划会保存为 session custom entry。`/resume`、`/reload`、session tree 切换或 compaction 后，扩展会根据当前分支最后一次 `codex-plan` 快照恢复状态：如果仍有 `pending` 或 `in_progress` 步骤，则恢复 overlay；如果最后一次计划已经全部 `completed`，则不会显示陈旧的常驻列表。

## Compact UI

此包包含 Codex 风格紧凑 UI 扩展：

- 用户消息使用 `›` 前缀和主题 `userMessageBg` 背景，不再显示 Pi 默认的大气泡。
- 模型消息使用 `•` 前缀和后续行缩进，减少消息块间的视觉重量。
- `read`、`grep`、`find`、`ls`、`bash`、`edit` 和 `write` 使用紧凑渲染；执行逻辑仍委托给 Pi 原生工具。

紧凑间距不是 theme token 能力；该行为由 `extensions/compact-ui` 扩展实现。

## 安装

```bash
pi install .
```

## 开发

```bash
npm install
npm test
npm run typecheck
```

## 参考源码

本地 `codex/` 目录是 OpenAI Codex 源码的参考检出。它被 git 忽略，也不是此包的一部分。

## 暂缓内容

`/side` 现在作为 extension-only 版本提供：它使用独立模型请求和 Pi overlay 复刻 Codex 的临时 side conversation。它不依赖 Pi 核心线程切换，因此 UI 行为不完全等同 Codex 原生实现，但关闭 overlay 即关闭 side 会话。

`task_agent` 已支持基于 Pi session 有效上下文的压缩感知后台 fork、主会话 provider/model/thinking 精确继承、长生命周期 teammate（跨会话安全 resume）和共享并发边界。选择性继承最近 N 轮上下文、根会话级 token/费用硬预算和嵌套 Agent 仍暂缓；递归 spawn 继续关闭。
