# Pi 能力总览

本包（`pi-codex-replica`）在**不修改 Pi 核心**的前提下，通过一组 Pi extension 为 Pi coding agent 增补了一批来自 Codex CLI 与 Claude Code 的能力，覆盖 TUI 皮肤、上下文管理、安全审批、会话管理、本地模型、工具接入与运维观测等维度。

本文档是所有扩展的**能力总表**。每个新增扩展都有一份独立详情文档，位于 [`docs/extensions/`](extensions/)；仓库原有的基础扩展列在文末。

> 让 Pi 运行时**自感知**这些能力：见 [`skills/pi-capabilities/SKILL.md`](../skills/pi-capabilities/SKILL.md)。当用户问“pi 有什么能力 / 某功能怎么用 / 有哪些命令”时，Pi 会加载该技能作速查。启用方式见文末「让 Pi 自感知能力」。

---

## 新增扩展（按 category 分组）

### TUI

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `claude-ui` | Claude Code 风格无边框 TUI 皮肤：● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· 展开键 `Ctrl+O` | [claude-ui.md](extensions/claude-ui.md) |
| `input-history` | 跨会话输入历史持久化 + 反向增量搜索，补齐原生编辑器只有会话内 ↑/↓ 的缺口。 | 反向搜索键 `Alt+R`（可改绑，如 `ctrl+r`） | [input-history.md](extensions/input-history.md) |
| `session-summary` | 输入框上方标题为 `summary`、框内全灰色的可滚动常驻摘要；模型、展示条数和用于理解指代的最近 N 轮上下文存入 `settings.json`。 | `/session-summary context <0-20>` · `/session-summary model <provider/model>` · `Alt+↑/↓` | [session-summary.md](extensions/session-summary.md) |

### 上下文

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `context-viewer` | 只读查看当前有效系统提示词及隐藏注入内容，排除聊天历史和工具结果。 | `/context` · `/system-prompt` | [context-viewer.md](extensions/context-viewer.md) |
| `context-pipeline` | 分层上下文管理：发送前按预算截断 tool_result、无 LLM 的 microcompact 清旧工具结果，并为 Pi 原生自动/手动压缩生成结构化摘要。 | `/prune`（`status`/`soft`/`hard`）· `/context-prune` | [context-pipeline.md](extensions/context-pipeline.md) |
| `compact-continue` | Pi 阈值压缩后保守判断是否仍有可执行工作；仅在 toolResult、截断/tool-use 回合或未完成计划等强信号下隐藏续跑一次，真实用户/自动队列优先。 | `--compact-continue`（默认开）· `--compact-continue=false` 关闭 | [compact-continue.md](extensions/compact-continue.md) |
| `agents-context` | 补充加载 Pi 原生不加载的 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· 环境变量 `PI_AGENTS_CONTEXT=0` | [agents-context.md](extensions/agents-context.md) |
| `settings-env` | 从全局和项目 `settings.json` 的顶层 `env` 读取环境变量并注入 Pi 进程；项目值覆盖全局值，已有启动环境默认优先。 | `env` · `envOverride` | [settings-env.md](extensions/settings-env.md) |
| `memory` | Claude Code 风格自动长期记忆：按 git 根零配置初始化，召回相关主题，并在命中长期信息时后台提炼、去重更新索引。 | `/memory list\|show\|init` · `/remember <text>`（可选手动入口） | [memory.md](extensions/memory.md) |

### 安全审批

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `approvals` | 唯一一道审批闸门：权限模式 × 规则库 × 命令安全 × 受保护路径 × MCP 逐工具，统一产出 allow/ask/deny。 | `/approvals`（`mode`/`rules`/`allow`/`ask`/`deny`/`remove`） | [approvals.md](extensions/approvals.md) |
| `plan-mode` | 只读规划闸门：进入后仅可探查，模型提交计划经用户批准后才恢复写工具。 | `/plan`（`on`/`off`）· `Alt+P` · 工具 `exit_plan_mode` | [plan-mode.md](extensions/plan-mode.md) |

### 会话

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `profiles` | 命名配置预设（模型 + 工具 + thinking + 审批模式）一键保存/切换/删除，支持 `--profile` 启动应用。 | `/profile`（`save`/`apply`/`delete`/`<name>`）· `--profile <name>` | [profiles.md](extensions/profiles.md) |
| `resume-picker` | 会话恢复选择器 + 跨项目会话全文检索（rg，缺失时降级内存匹配），命中后切回历史会话。 | `/resume-picker [--all] [过滤词]` · `/search <关键词>` | [resume-picker.md](extensions/resume-picker.md) |
| `autopilot` | 自主续跑控制器：一轮结束后自动注入隐藏 follow-up 连续推进，默认关闭，按预算/轮数/收益递减自动停止。 | `/autopilot`（`on [objective]`/`off`/`status`） | [autopilot.md](extensions/autopilot.md) |
| `loop` | Claude Code 风格定时循环：立即执行一次提示词，之后在 agent 空闲时按固定间隔重复；会话内生效并在 7 天后自动过期。 | `/loop [interval] <prompt>` · `/loop list` · `/loop cancel <id\|all>` | [loop.md](extensions/loop.md) |

### 模型

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `effort` | 通用 thinking 档位、两级高级选择器、模型+档位原子选择和推理升降快捷键。 | `/effort [status\|off\|minimal\|low\|medium\|high\|xhigh\|max\|ultra]` · `/model` · `Alt+,` / `Alt+.` | [effort.md](extensions/effort.md) |
| `fast-mode` | Codex Fast service tier：对支持的 openai-codex OAuth 模型发送 `service_tier: "priority"`，约 1.5× 速度但增加额度消耗。 | `/fast [on\|off\|status]` · `--fast` | [fast-mode.md](extensions/fast-mode.md) |
| `ultra` | Codex Ultra controller：Sol/Terra 会话态 Ultra、wire `max`，自动激活 `task_agent` 并注入可执行的并行 workflow；Plan 模式安全暂停。 | 由 `/effort ultra` / `/model` 进入 | [ultra.md](extensions/ultra.md) |
| `cursor` | Cursor 订阅原生 provider：显式登录、实时模型目录、Pi 工具闭环；不执行 Cursor 原生文件/Shell/fetch。 | `/login cursor` · `/model cursor` · `/cursor [status\|models\|refresh\|usage]` | [cursor.md](extensions/cursor.md) |
| `local-models` | 发现本地大模型运行时（Ollama、LM Studio）并注册为指向 localhost 的 OpenAI 兼容 provider，支持列举/拉取/就绪检查。 | `/local-models`（`list`/`pull`/`ensure_ready`）· 别名 `/ollama` `/lm` | [local-models.md](extensions/local-models.md) |
| `codebuddy-reasoning` | 对齐 CodeBuddy 原生 `gpt-5.6-sol` 请求参数，使 High thinking 返回并展示可见推理摘要。 | 无命令，自动生效 | — |

### 联网

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `webfetch` | 联网抓取 + 网络搜索（移植 Claude WebFetch，搜索语义对齐 Codex `web.run`）：给 URL → 本地 fetch → HTML 转 markdown；给 `query`/搜索词 → DeepSeek Search 返回带标题/URL/日期/摘要的排序结果，可用 `source: "S3"` 重开；本地正文为空（SPA 空壳/403/二进制）时自动用 DeepSeek Fetch 服务端渲染兜底。SSRF 防护（私有段拦截 + 连接前 DNS 守卫 + 重定向逐跳校验）、10MB 流式截断、100K 字符上限、页面与搜索双缓存（Search/Fetch 按次计费）、408/429/5xx 退避重试。 | 工具 `webfetch` · `/webfetch [status\|reload]` · `--webfetch`（默认开） · `DEEPSEEK_API_KEY` | [webfetch.md](extensions/webfetch.md) |
| `channel` | 通用外部 HTTP 入站：在配置 Bearer Token 后监听 `0.0.0.0:4317`，经校验、幂等和限流将外部事件按 steer/follow-up/next-turn 语义注入并可唤醒当前 Pi 会话。 | `/channel [status\|restart]` · `POST /v1/messages` · `PI_CHANNEL_TOKEN` | [channel.md](extensions/channel.md) |

### 工具

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `mcp` | 内置 MCP 客户端：读 `.pi/mcp.json` 连 stdio/http server，把远端工具暴露为 `mcp__<server>__<tool>`，审批由 approvals 兜底。 | `/mcp`（`list`/`status`/`add`/`remove`/`reconnect`） | [mcp.md](extensions/mcp.md) |
| `plugin-loader` | 发现磁盘上 Claude/pi/Cursor 风格插件，把其 skills/commands/themes/output-styles 接入 Pi（MCP 交给 mcp 扩展）。 | `/plugin`（`list`/`enable`/`disable`） | [plugin-loader.md](extensions/plugin-loader.md) |
| `hooks-runner` | 配置驱动的 hook 框架：把 Pi 生命周期事件桥接到 Claude Code 的 JSON hook 决策协议，可拦截/改写工具参数/注入上下文。 | `/hooks` · 配置 `.pi/hooks.json` | [hooks-runner.md](extensions/hooks-runner.md) |
| `agents` | 加载 Claude 风格 subagent 角色 `.md` + 内置角色库，把角色应用到当前会话（收敛工具白名单 + 注入一次性系统提示）。 | `/agents`（`list`/`show <name>`/`use <name>`） | [agents.md](extensions/agents.md) |
| `migrate` | 一次性把 Claude Code / Cursor 的 MCP、subagents、commands、hooks、memory 配置导入 Pi 的 `.pi/`，只导缺失绝不覆盖。 | `/migrate [category]` · `--dry-run` | [migrate.md](extensions/migrate.md) |

### 运维

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `monitor` | 只读效果监控：缓存命中率、上下文构成、清理/压缩回收比，经面板与 footer 展示，不进 LLM 上下文。 | `/monitor` | [monitor.md](extensions/monitor.md) |
| `token-speed` | 底部 token 生成速度：流式实时估算 + 每条响应精确 tok/s，含 TTFT、decode 窗口、会话加权平均与最近序列，不进 LLM 上下文。 | `/speed` · `/speed on\|off\|status` · `--token-speed=false` | [token-speed.md](extensions/token-speed.md) |
| `cost-usage` | 只读追踪会话美元成本、按模型 token、时长与编辑增删行；OAuth 模式额外展示 Codex 订阅套餐额度、窗口与重置时间。 | `/cost` · 别名 `/usage` | [cost-usage.md](extensions/cost-usage.md) |

---

## 仓库原有扩展

以下为本包更早期已提供的基础扩展（详情见 [README.md](../README.md) 对应章节）。多 Agent 的运行模式、隔离、恢复、审批与容量限制另见 [multi-agent.md](extensions/multi-agent.md)：

| 扩展 | 一句话能力 | 主要命令 / 工具 |
|---|---|---|
| `diff` | 展示 Git 工作树变更；[会话文件审阅](extensions/session-git-review.md)支持确认隐藏、变更重现、目录和跨目录仓库模式。 | `/diff` · `/changes` · `Ctrl+R` |
| `review` | Codex 风格本地 Git Review：对比基准分支（PR diff）/ 未提交变更 / 某提交 / 自定义指令；只读当前工作树，不连接 GitHub。 | `/review [instructions]` |
| `init` | 通过主 agent 检查项目并创建简洁的 `AGENTS.md` 指南（已存在则跳过）。 | `/init` |
| `imagegen` | Codex 订阅生图：复刻 codex 内置 `image_gen.imagegen`，走 openai-codex OAuth 直连 ChatGPT 图片 API（gpt-image-2），结果保存到 `~/.pi/agent/generated_images/<session>/` 并默认回传模型迭代。 | 工具 `generate_image` |
| `todo` | Codex 风格 `update_plan`（整份计划快照）+ 常驻 plan overlay + session 恢复。 | 工具 `update_plan` |
| `compact-ui` | Codex 风格紧凑 UI：用户/模型消息前缀化，常见内置工具短渲染（与 claude-ui 互斥）。 | `--claude-ui=false` 回退到此皮肤 |
| `pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `goal` | Codex 风格 thread goal：持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | 工具 `get_goal`/`create_goal`/`update_goal` · `/goal <objective>` · `/goal resume` |
| `side` | `/side` 在 Pi overlay 中用当前 leaf 的 compaction-aware 上下文启动临时 side 对话，关闭窗口即丢弃。 | `/side [message]` |
| `localagent` | 默认从当前持久会话完整 fork 后台子 agent；精确继承主会话 provider/model/thinking，终态自动回传最终回答。传 `team_name`+`name` 改为创建长生命周期 teammate。 | 工具 `task_agent` |
| `localshell` | 注册 `task_bash` 工具 + LocalShellTask；前台命令零额外通知，超时自动转后台，后台终态默认只在安全边界更新 TUI，Bash 调用/输出样式对齐 Claude UI。 | 工具 `task_bash` / `task_status` / `task_kill`；`PI_TASKS_WAKE_ON_BACKGROUND=1` 可主动唤醒 LLM |
| `tasks` | 任务框架底座：TaskStore、背景 agents panel、查询管理工具，以及根 session 共享 resident/execution 容量控制。 | 工具 `task_status`/`task_kill`/`task_list` |
| `teammate` | 长生命周期团队：`name@team` 隔离、共享任务看板、自动结果、未 ACK 消息重放、硬写审批、role 指纹 fail-closed resume 与优雅关闭。 | 工具 `team_create`/`task_agent(team_name+name)`/`send_message`/`request_plan_approval`/`team_delete`/`team_plan_approve` + team task 工具 |
| `user-input` | 向用户提问 1-3 个带选项的问题（UI 自动加 `Other` 自由文本项）。 | 工具 `request_user_input`/`ask_user_question`/`askUserQuestion` |

---

## 让 Pi 自感知能力

本包提供了一个 **capabilities skill**（[`skills/pi-capabilities/SKILL.md`](../skills/pi-capabilities/SKILL.md)），把上表的命令/能力速查、何时用哪个、指向 `docs/extensions/*` 的路径整理成一份 on-demand 技能。

启用方式（任选其一）：

1. **包内自动发现（本包已配置）**：`package.json` 的 `pi.skills` 指向 `./skills`，安装本包后 Pi 会扫描 `skills/` 下含 `SKILL.md` 的目录自动发现。
2. **设置里显式添加路径**：在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 的 `skills` 数组里加入本目录，例如 `"skills": ["<包路径>/skills/pi-capabilities"]`。
3. **强制加载**：交互模式下运行 `/skill:pi-capabilities`（需 `enableSkillCommands: true`）。

技能只包含描述常驻上下文，完整正文在命中时才由模型 `read` 加载（progressive disclosure）。
