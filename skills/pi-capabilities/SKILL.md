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
| `/local-models [list\|pull\|ensure_ready]`, `/ollama`, `/lm` | local-models | 发现/拉取/就绪检查本地模型(Ollama/LM Studio) |
| `/mcp [list\|status\|add\|remove\|reconnect]` | mcp | 管理 MCP server 连接 |
| `/plugin`, `/plugin marketplace …`, `/plugin install\|remove\|update …` | plugin-loader | 管理 Marketplace 与 user/project/local scope 的 Claude 风格插件 |
| `/hooks` | hooks-runner | 列出已配置生命周期 hook |
| `/agents [list\|show <name>\|use <name>]` | agents | 查看/应用 subagent 角色 |
| `/migrate [mcp\|agents\|commands\|hooks\|memory]` | migrate | 导入 Claude/Cursor 配置到 .pi/ |
| `/memory [list\|show\|init]`, `/remember <text>` | memory | 长期记忆管理与写入 |
| `/monitor` | monitor | 效果监控面板(缓存/上下文构成/回收比) |
| `/cost`, `/usage` | cost-usage | 会话成本与 token 用量面板 |
| `/diff` | diff | git 工作树变更(含未跟踪) |
| `/review [指令]` | review | Codex 风格评审预设 |
| `/init` | init | 生成项目 AGENTS.md |
| `/images` | imagegen | 图片路径展示器 |
| `/side [message]` | side | 临时 fork side 会话 overlay |
| `/goal <目标>`, `/goal resume` | goal | thread goal 创建/恢复 |

## 无命令 / 靠 flag 或按键的能力

- **claude-ui**：Claude Code 风格无边框 TUI 皮肤（● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff）。`--claude-ui`（默认开），长输出用 `Ctrl+O` 展开/收起；`--claude-ui=false` 回退 compact-ui。
- **compact-ui**：Codex 风格紧凑 UI（消息前缀化 + 内置工具短渲染），与 claude-ui 互斥。
- **input-history**：跨会话输入历史 + 反向增量搜索，默认 `Alt+R`（可改绑 `ctrl+r`）。
- **agents-context**：自动加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则；`--agents-context`（默认开）/ `PI_AGENTS_CONTEXT=0`。
- **settings-env**：启动时读取全局和项目 `settings.json` 顶层 `env` 并注入 `process.env`；已有启动环境默认优先，`envOverride: true` 可覆盖。
- **pets**：终端宠物 widget，依 agent 状态切换动画。

## 模型可调用的工具（非命令）

- **task_agent**（localagent）：后台跑本地子 agent。
- **task_bash**（localshell）：后台执行 shell 命令（超时自动转后台）。
- **task_status / task_kill / task_list**（tasks）：任务框架的查询与管理。
- **team_create / send_message / request_plan_approval / team_delete / team_plan_approve** + team task 工具（teammate）：多 agent 团队协作。
- **update_plan**（todo）：整份计划快照更新 + 常驻 overlay。
- **get_goal / create_goal / update_goal**（goal）：thread 持久目标。
- **generate_image**（imagegen）：生图，只返回路径。
- **request_user_input / ask_user_question / askUserQuestion**（user-input）：向用户提 1-3 个带选项的问题。
- **exit_plan_mode**（plan-mode）：模型提交计划并请求退出只读规划。
- **mcp__<server>__<tool>**（mcp）：远端 MCP 工具注册成的 Pi 原生工具。
- **webfetch**（webfetch）：联网抓取公开 URL → HTML 转 markdown 交模型阅读；SSRF 防护 + 10MB/100K 上限 + 15min 缓存。`--webfetch` 默认开。

## 何时用哪个

- **上下文快满 / 想压缩**：`/prune`（软清理或全量压缩）；想看构成占比用 `/monitor`；context-pipeline 还会自动截断 tool_result 并自动压缩。
- **控制“能不能执行某工具/命令”**：`/approvals`（规则 + default/acceptEdits/bypass 模式，保护 .git/.pi/~/.ssh，拦 rm -rf/sudo 等）。
- **想先看方案再动手**：`/plan`（只读探查→提交计划→批准后恢复写工具）。
- **想让 agent 不停手连续推进长任务**：`/autopilot on [目标]`（有预算/轮数/收益递减停止）。
- **切回过去的会话 / 找以前聊过的内容**：`/resume-picker`、`/search`(pi 内置 `/resume` 也能朴素切换会话)。
- **常用配置组合一键切换**：`/profile save` 后 `/profile <name>`，或 `--profile` 启动应用。
- **接外部工具 / 第三方能力**：`/mcp add`（MCP server）；Claude 风格插件用 `/plugin marketplace add` 后 `/plugin install`。
- **复用已有 Claude/Cursor 配置**：`/migrate`。
- **跨会话记住偏好/事实**：memory 默认自动初始化、召回和按需提炼；`/remember`、`/memory` 只在需要强制记录、查看或纠错时使用。
- **用本地模型**：`/local-models list` / `pull` / `ensure_ready`。
- **要花了多少钱 / 用了多少 token**：`/cost`。
- **生命周期自动化（提交前/工具前后注入或拦截）**：hooks-runner + `/hooks`，配置 `.pi/hooks.json`。
- **切换 agent 角色（只读探索/规划/验证等）**：`/agents use <name>`。
- **调出以前输入过的 prompt**：`Alt+R` 反向搜索（input-history）。
- **切换 TUI 观感**：`--claude-ui`（默认，Claude 风格）↔ `--claude-ui=false`（compact-ui）。
- **抓取网页 / 查在线文档 / 读 URL 内容**：`webfetch`（公开 URL → HTML 转 markdown 交模型读；SSRF 防护;认证 / 私有页请改用 MCP 或 `gh`）。
- **在 settings.json 配环境变量**：用 settings-env 的顶层 `env`；项目配置覆盖全局配置，但默认不覆盖启动 Pi 时已有的变量。

## 详情文档

- 新增扩展文档：`docs/extensions/{claude-ui,input-history,context-pipeline,agents-context,settings-env,memory,approvals,plan-mode,profiles,resume-picker,autopilot,local-models,mcp,plugin-loader,hooks-runner,agents,migrate,monitor,cost-usage}.md`
- 原有基础扩展（diff/review/init/imagegen/todo/compact-ui/pets/goal/side/localagent/localshell/tasks/teammate/user-input）：见仓库 `README.md`
- 总表：`docs/CAPABILITIES.md`
