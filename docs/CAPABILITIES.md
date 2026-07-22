# Pi 能力总览

本包（`pi-codex-replica`）在**不修改 Pi 核心**的前提下，通过一组 Pi extension 为 Pi coding agent 增补了一批来自 Codex CLI 与 Claude Code 的能力，覆盖 TUI 皮肤、上下文管理、安全审批、会话管理、本地模型、工具接入与运维观测等维度。

本文档是所有扩展的**能力总表**。每个新增扩展都有一份独立详情文档，位于 [`docs/extensions/`](extensions/)；仓库原有的基础扩展列在文末。

> 让 Pi 运行时**自感知**这些能力：见 [`skills/pi-capabilities/SKILL.md`](../skills/pi-capabilities/SKILL.md)。当用户问“pi 有什么能力 / 某功能怎么用 / 有哪些命令”时，Pi 会加载该技能作速查。启用方式见文末「让 Pi 自感知能力」。

---

## 新增扩展（18 个，按 category 分组）

### TUI

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `claude-ui` | Claude Code 风格无边框 TUI 皮肤：● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· 展开键 `Ctrl+O` | [claude-ui.md](extensions/claude-ui.md) |
| `input-history` | 跨会话输入历史持久化 + 反向增量搜索，补齐原生编辑器只有会话内 ↑/↓ 的缺口。 | 反向搜索键 `Alt+R`（可改绑，如 `ctrl+r`） | [input-history.md](extensions/input-history.md) |

### 上下文

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `context-pipeline` | 分层上下文管理：发送前按预算截断 tool_result、无 LLM 的 microcompact 清旧工具结果、接近窗口上限时自动结构化压缩。 | `/prune`（`status`/`soft`/`hard`）· `/context-prune` | [context-pipeline.md](extensions/context-pipeline.md) |
| `agents-context` | 补充加载 Pi 原生不加载的 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· 环境变量 `PI_AGENTS_CONTEXT=0` | [agents-context.md](extensions/agents-context.md) |
| `memory` | Claude 风格长期记忆：按 git 根划分的 `.pi/memory` + `MEMORY.md` 索引，每轮注入相关主题，compaction 后重注入。 | `/memory list\|show\|init` · `/remember <text>` | [memory.md](extensions/memory.md) |

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

### 模型

| 扩展 | 一句话能力 | 主要命令 / 入口 | 详情 |
|---|---|---|---|
| `local-models` | 发现本地大模型运行时（Ollama、LM Studio）并注册为指向 localhost 的 OpenAI 兼容 provider，支持列举/拉取/就绪检查。 | `/local-models`（`list`/`pull`/`ensure_ready`）· 别名 `/ollama` `/lm` | [local-models.md](extensions/local-models.md) |

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
| `cost-usage` | 只读追踪会话美元成本、按模型 token、时长与编辑增删行，面板 + footer $ 状态 + 跨会话持久化。 | `/cost` · 别名 `/usage` | [cost-usage.md](extensions/cost-usage.md) |

---

## 仓库原有扩展

以下为本包更早期已提供的基础扩展（详情见 [README.md](../README.md) 对应章节）：

| 扩展 | 一句话能力 | 主要命令 / 工具 |
|---|---|---|
| `diff` | 展示已跟踪和未跟踪的 git 工作树变更。 | `/diff` |
| `review` | Codex 风格评审预设：对比基准分支 / 未提交变更 / 某提交 / 自定义指令。 | `/review [instructions]` |
| `init` | 通过主 agent 检查项目并创建简洁的 `AGENTS.md` 指南（已存在则跳过）。 | `/init` |
| `imagegen` | OpenAI Images 生图工具 + 图片路径展示器（结果只返回路径不入上下文）。 | 工具 `generate_image` · `/images` |
| `todo` | Codex 风格 `update_plan`（整份计划快照）+ 常驻 plan overlay + session 恢复。 | 工具 `update_plan` |
| `compact-ui` | Codex 风格紧凑 UI：用户/模型消息前缀化，常见内置工具短渲染（与 claude-ui 互斥）。 | `--claude-ui=false` 回退到此皮肤 |
| `pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `goal` | Codex 风格 thread goal：持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | 工具 `get_goal`/`create_goal`/`update_goal` · `/goal <objective>` · `/goal resume` |
| `side` | `/side` 在 Pi overlay 中从当前 leaf fork 临时 side subagent，关闭窗口即关闭 side 会话。 | `/side [message]` |
| `localagent` | 注册 `task_agent` 工具 + `local_agent` 任务类型，在进程内后台跑本地子 agent。 | 工具 `task_agent` |
| `localshell` | 注册 `task_bash` 工具 + LocalShellTask，后台执行 shell 命令（超时可自动转后台）。 | 工具 `task_bash` |
| `tasks` | 任务框架底座：进程内 default TaskStore + 背景 agents panel（Ctrl+T 焦点 / Enter overlay）+ 任务查询/管理工具。 | 工具 `task_status`/`task_kill`/`task_list` |
| `teammate` | 多 agent 团队协作：创建团队、成员间消息、计划审批与团队任务看板。 | 工具 `team_create`/`send_message`/`request_plan_approval`/`team_delete`/`team_plan_approve` + team task 工具 |
| `user-input` | 向用户提问 1-3 个带选项的问题（UI 自动加 `Other` 自由文本项）。 | 工具 `request_user_input`/`ask_user_question`/`askUserQuestion` |

---

## 让 Pi 自感知能力

本包提供了一个 **capabilities skill**（[`skills/pi-capabilities/SKILL.md`](../skills/pi-capabilities/SKILL.md)），把上表的命令/能力速查、何时用哪个、指向 `docs/extensions/*` 的路径整理成一份 on-demand 技能。

启用方式（任选其一）：

1. **包内自动发现（本包已配置）**：`package.json` 的 `pi.skills` 指向 `./skills`，安装本包后 Pi 会扫描 `skills/` 下含 `SKILL.md` 的目录自动发现。
2. **设置里显式添加路径**：在 `~/.pi/agent/settings.json` 或项目 `.pi/settings.json` 的 `skills` 数组里加入本目录，例如 `"skills": ["<包路径>/skills/pi-capabilities"]`。
3. **强制加载**：交互模式下运行 `/skill:pi-capabilities`（需 `enableSkillCommands: true`）。

技能只包含描述常驻上下文，完整正文在命中时才由模型 `read` 加载（progressive disclosure）。
