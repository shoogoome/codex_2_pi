---
name: pi-capabilities
description: 本包(pi-codex-replica)为 Pi 增补的全部扩展能力速查。当用户问“pi/你自己有什么能力、能做什么、装了哪些扩展”、问“某个功能怎么用、有什么用”、问“有哪些命令/斜杠命令/工具”、或想在多个相近功能间选择（如上下文压缩、审批、会话恢复、本地模型、MCP、记忆、hooks 等）时读此技能。它给出每个扩展的一句话能力、主要命令/工具、何时用哪个，并指向 docs/extensions/* 详情。
---

# Pi 能力速查（pi-capabilities）

本包在不改 Pi 核心的前提下，用一组 extension 为 Pi 增补 Codex CLI / Claude Code 风格能力。
下面是命令 / 工具 / 何时用哪个的速查。完整总表见 `docs/CAPABILITIES.md`；每个扩展的详情见 `docs/extensions/<名>.md`。

回答用户“怎么用某功能”时，先在此定位扩展，再 `read` 对应 `docs/extensions/<名>.md` 给出准确细节。

## 命令速查（斜杠命令）

| 命令 | 扩展 | 作用 |
|---|---|---|
| `/prune [status\|soft\|hard]`, `/context-prune` | context-pipeline | 看/释放上下文占用、手动压缩 |
| `/approvals [mode\|rules\|allow\|ask\|deny\|remove]` | approvals | 查看/设置工具与命令的执行审批规则、切换 default/acceptEdits/bypass |
| `/plan [on\|off]`（`Alt+P`） | plan-mode | 进入/退出只读规划闸门 |
| `/profile [save\|apply\|delete\|<name>]` | profiles | 保存/切换模型+工具+thinking+审批的命名预设 |
| `/resume-picker [--all] [过滤词]`, `/search <关键词>` | resume-picker | 恢复历史会话、跨项目全文检索会话（改名避让 pi 内置 `/resume`) |
| `/autopilot [on [目标]\|off\|status]` | autopilot | 自主续跑控制器 |
| `/loop [interval] <prompt>`、`/loop list`、`/loop cancel <id\|all>` | loop | 定时重复运行提示词或斜杠命令；创建后立即执行一次 |
| `/effort [status\|off\|minimal\|low\|medium\|high\|xhigh\|max\|ultra]`、`/model`、`Alt+,` / `Alt+.` | effort + ultra | 两级选择 thinking；Ultra 为 Sol/Terra 开启 wire max、自动激活 `task_agent` 与主动并行 workflow（Plan 模式暂停） |
| `/fast [on\|off\|status]` | fast-mode | 为支持的 openai-codex OAuth 模型切换 priority service tier（更快但更耗额度） |
| `/local-models [list\|pull\|ensure_ready]`, `/ollama`, `/lm` | local-models | 发现/拉取/就绪检查本地模型(Ollama/LM Studio) |
| `/mcp [list\|status\|add\|remove\|reconnect]` | mcp | 管理 MCP server 连接 |
| `/channel [status\|restart\|auth\|send]` | channel | 管理具名 HTTP/微信 Channel；默认多会话挂载，每个 Pi 会话可独立设置通信方向 |
| `/plugin`, `/plugin marketplace …`, `/plugin install\|remove\|update …` | plugin-loader | 管理 Marketplace 与 user/project/local scope 的 Claude 风格插件 |
| `/hooks` | hooks-runner | 列出已配置生命周期 hook |
| `/agents [list\|show <name>\|use <name>]` | agents | 查看/应用 subagent 角色 |
| `/migrate [mcp\|agents\|commands\|hooks\|memory]` | migrate | 导入 Claude/Cursor 配置到 .pi/ |
| `/memory [list\|show\|init]`, `/remember <text>` | memory | 长期记忆管理与写入 |
| `/session-summary [status\|on\|off\|clear\|context\|lines\|model]` | session-summary | 管理标题为 `summary` 的全灰色可滚动摘要；模型、条数及最近 N 轮上下文存入全局 settings.json |
| `/monitor` | monitor | 效果监控面板(缓存/上下文构成/回收比) |
| `/speed` | token-speed | 底部 token 生成速度(tok/s)面板；footer 实时估算 + 精确测量 |
| `/cost`, `/usage` | cost-usage | 会话成本与 token 用量面板 |
| `/diff` | diff | git 工作树变更(含未跟踪) |
| `/review [指令]` | review | Codex 风格评审预设 |
| `/init` | init | 生成项目 AGENTS.md |
| `/side [message]` | side | 基于当前 leaf 上下文的临时 side 会话 overlay |
| `/goal <目标>`, `/goal resume` | goal | thread goal 创建/恢复 |

## 无命令 / 靠 flag 或按键的能力

- **claude-ui**：Claude Code 风格无边框 TUI 皮肤（● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff）。`--claude-ui`（默认开），长输出用 `Ctrl+O` 展开/收起；`--claude-ui=false` 回退 compact-ui。
- **compact-ui**：Codex 风格紧凑 UI（消息前缀化 + 内置工具短渲染），与 claude-ui 互斥。
- **input-history**：跨会话输入历史 + 反向增量搜索，默认 `Alt+R`（可改绑 `ctrl+r`）。
- **session-summary**：输入框上方用标题为 `summary` 的全灰色边框区显示“用户一行 + 每次完整 Agent run 一行”；默认给摘要模型附带最近 3 轮可见对话以理解指代，`/session-summary context <0-20>` 可调，模型、条数和上下文轮数写入 settings.json，生成的摘要不会进入主 LLM 上下文。
- **compact-continue**：Pi 阈值压缩后若检测到 toolResult、截断/tool-use 回合或未完成计划，会隐藏续跑一次；默认开，`--compact-continue=false` 关闭，真实用户/自动队列优先。
- **agents-context**：自动加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则；`--agents-context`（默认开）/ `PI_AGENTS_CONTEXT=0`。
- **settings-env**：启动时读取全局和项目 `settings.json` 顶层 `env` 并注入 `process.env`；已有启动环境默认优先，`envOverride: true` 可覆盖。
- **pets**：终端宠物 widget，依 agent 状态切换动画。
- **token-speed**：footer 常驻 `⚡ 42.3 tok/s · avg 38.1`（流式中显示 `⚡ ~167 tok/s` 估算），`--token-speed=false` 关闭；测量口径为首个→最后 delta 的 decode 窗口。

## 模型可调用的工具（非命令）

- **task_agent**（localagent）：从当前持久会话完整 fork 后台子 agent，精确继承主会话 provider/model/thinking，终态自动回传最终回答。
- **task_bash**（localshell）：后台执行 shell 命令（超时自动转后台）。
- **task_status / task_kill / task_list**（tasks）：任务框架的查询与管理。
- **update_plan**（todo）：整份计划快照更新 + 常驻 overlay。
- **get_goal / create_goal / update_goal**（goal）：thread 持久目标。
- **generate_image**（imagegen）：Codex 订阅生图/编辑（gpt-image-2，走 openai-codex OAuth），保存到 `~/.pi/agent/generated_images/<session>/` 并默认把图返回模型迭代；`--imagegen-return-image=false` 可只返回路径。
- **request_user_input / ask_user_question / askUserQuestion**（user-input）：向用户提 1-3 个带选项的问题。
- **exit_plan_mode**（plan-mode）：模型提交计划并请求退出只读规划。
- **mcp__<server>__<tool>**（mcp）：远端 MCP 工具注册成的 Pi 原生工具。
- **webfetch**（webfetch）：联网抓取公开 URL → HTML 转 markdown 交模型阅读；SSRF 防护 + 10MB/100K 上限 + 15min 缓存。`--webfetch` 默认开。

## 何时用哪个

- **上下文快满 / 想压缩**：`/prune`（软清理或手动全量压缩）；想看构成占比用 `/monitor`；context-pipeline 会自动截断 tool_result，并为 Pi 原生自动压缩生成结构化摘要；compact-continue 会在阈值压缩确实切断未完成工作时保守续跑一次。
- **控制“能不能执行某工具/命令”**：`/approvals`（规则 + default/acceptEdits/bypass 模式，保护 .git/.pi/~/.ssh，拦 rm -rf/sudo 等）。
- **想先看方案再动手**：`/plan`（只读探查→提交计划→批准后恢复写工具）。
- **想让 agent 不停手连续推进长任务**：`/autopilot on [目标]`（有预算/轮数/收益递减停止）。
- **想定时轮询状态或重复执行命令**：`/loop [interval] <prompt>`（会立即执行一次，后续仅在空闲时触发）。
- **切回过去的会话 / 找以前聊过的内容**：`/resume-picker`、`/search`(pi 内置 `/resume` 也能朴素切换会话)。
- **常用配置组合一键切换**：`/profile save` 后 `/profile <name>`，或 `--profile` 启动应用。
- **接外部工具 / 第三方能力**：`/mcp add`（Pi 主动调用 MCP server）；Claude 风格插件用 `/plugin marketplace add` 后 `/plugin install`。
- **让告警、CI、IDE、微信等外部系统与 Pi 通信**：用 `/channel` 管理具名 Channel；新建默认多会话，各会话可独立设为入站、出站或双向。旧 HTTP 可继续配置 `PI_CHANNEL_TOKEN` 并调用 `POST /v1/messages`。
- **复用已有 Claude/Cursor 配置**：`/migrate`。
- **跨会话记住偏好/事实**：memory 默认自动初始化、召回和按需提炼；`/remember`、`/memory` 只在需要强制记录、查看或纠错时使用。
- **调模型推理强度 / 开 Codex Ultra 编排**：`/effort` 或 `/model` 两级选择器；Sol/Terra 的 Ultra 会自动激活 `task_agent`，在适合时并行委派并等待自动终态结果综合。
- **Codex 订阅优先加速**：`/fast`；仅支持官方 catalog 声明 Fast 的 openai-codex OAuth 模型，速度更快但额度消耗增加，与 reasoning effort 相互独立。
- **用本地模型**：`/local-models list` / `pull` / `ensure_ready`。
- **要花了多少钱 / 用了多少 token**：`/cost`。
- **想知道模型生成得快不快**：看 footer 的 `⚡ … tok/s`（流式中是实时估算，空闲时是最近一条 + 会话平均）；`/speed` 展开 TTFT / decode 窗口 / 最近序列明细，`/speed off` 关掉 footer 行。
- **生命周期自动化（提交前/工具前后注入或拦截）**：hooks-runner + `/hooks`，配置 `.pi/hooks.json`。
- **切换 agent 角色（只读探索/规划/验证等）**：`/agents use <name>`。
- **调出以前输入过的 prompt**：`Alt+R` 反向搜索（input-history）。
- **快速感知当前会话在做什么**：看输入框上方的 session-summary；用 `/session-summary model global <provider/model>` 给所有会话统一选择便宜的小模型。
- **切换 TUI 观感**：`--claude-ui`（默认，Claude 风格）↔ `--claude-ui=false`（compact-ui）。
- **抓取网页 / 查在线文档 / 读 URL 内容**：`webfetch`（公开 URL → HTML 转 markdown 交模型读；SSRF 防护;认证 / 私有页请改用 MCP 或 `gh`）。
- **在 settings.json 配环境变量**：用 settings-env 的顶层 `env`；项目配置覆盖全局配置，但默认不覆盖启动 Pi 时已有的变量。

## 详情文档

- 新增扩展文档：`docs/extensions/{claude-ui,input-history,session-summary,context-pipeline,compact-continue,agents-context,settings-env,channel,memory,approvals,plan-mode,profiles,resume-picker,autopilot,loop,effort,fast-mode,ultra,multi-agent,local-models,mcp,plugin-loader,hooks-runner,agents,migrate,monitor,token-speed,cost-usage}.md`
- 原有基础扩展（diff/review/init/imagegen/todo/compact-ui/pets/goal/side/localagent/localshell/tasks/user-input）：见仓库 `README.md`
- 总表：`docs/CAPABILITIES.md`
