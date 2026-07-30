# Pi Codex Replica

一个独立的 Pi 包，用于在不修改 Pi 核心的情况下复刻部分 Codex CLI 能力。

## 包含的扩展

完整能力总表、分组与详情链接见 [`docs/CAPABILITIES.md`](docs/CAPABILITIES.md)；下表列出当前全部扩展。

### 基础扩展（Codex 复刻）

| 扩展 | 能力 | 主要命令 / 工具 |
|---|---|---|
| `extensions/diff` | 展示已跟踪和未跟踪的 git 变更。 | `/diff` |
| `extensions/review` | 提供 Codex 风格的评审预设（基准分支 / 未提交 / 某提交 / 自定义）。 | `/review [instructions]` |
| `extensions/user-input` | 向用户提问 1-3 个带选项的问题（UI 自动加 `Other` 自由文本项）。 | `request_user_input` / `ask_user_question` / `askUserQuestion` |
| `extensions/side` | 在 Pi overlay 中从当前 leaf 启动临时 fork subagent，关闭窗口即关闭 side 会话。 | `/side [message]` |
| `extensions/init` | 通过主 agent 检查项目并创建项目 `AGENTS.md` 指南（已存在则跳过）。 | `/init` |
| `extensions/imagegen` | OpenAI Images 生图工具 + 图片路径展示器（结果只返回路径）。 | `generate_image` · `/images` |
| `extensions/todo` | Codex 风格 `update_plan`（整份计划快照）+ 计划渲染 + 常驻 plan overlay。 | `update_plan` |
| `extensions/compact-ui` | Codex 风格紧凑 UI:消息前缀化 + 常见内置工具短渲染（与 claude-ui 互斥）。 | （`--claude-ui=false` 回退到此皮肤） |
| `extensions/pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `extensions/goal` | Codex 风格 thread goal:持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | `get_goal` / `create_goal` / `update_goal` · `/goal <objective>` · `/goal resume` |
| `extensions/localagent` | 注册 `task_agent` 工具 + `local_agent` 任务类型，进程内后台跑本地子 agent。 | `task_agent` |
| `extensions/localshell` | 注册 `task_bash` 工具 + LocalShellTask：前台完成只保留一条 Bash 工具结果，超时转后台；后台终态默认在空闲时即时、忙时于 agent_end 安全边界更新 TUI，不打断/注入 LLM，调用头、输出 gutter、颜色和折叠与 Claude UI 的 `Bash` 一致。 | `task_bash` · `task_status` / `task_kill` · `PI_TASK_BASH_TIMEOUT_MS` 调默认超时 · `PI_TASKS_WAKE_ON_BACKGROUND=1` 可恢复 Claude 式主动唤醒 |
| `extensions/tasks` | 任务框架底座:default TaskStore + 背景 agents panel（Ctrl+Y 焦点 / Enter overlay）+ 任务查询管理工具。 | `task_status` / `task_kill` / `task_list` |
| `extensions/teammate` | 多 agent 团队协作:创建团队、成员间消息、计划审批、团队任务看板。 | `team_create` / `send_message` / `request_plan_approval` / `team_delete` / `team_plan_approve` |

### 新增扩展（Codex + Claude Code 能力移植）

| 扩展 | 能力 | 主要命令 / 入口 |
|---|---|---|
| `extensions/claude-ui` | Claude Code 风格无边框 TUI 皮肤:● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· `Ctrl+O` 展开 |
| `extensions/input-history` | 跨会话输入历史持久化 + 反向增量搜索。 | `Alt+R`（可改绑 `ctrl+r`） |
| `extensions/context-pipeline` | 分层上下文管理：按预算截断 tool_result、microcompact 清旧结果（默认手动，保护 prompt 缓存），并为 Pi 原生压缩生成结构化摘要。 | `/prune [status\|soft\|hard]` · `/context-prune` · `--prune-auto` / `PI_CTXPIPE_PRUNE_MODE=auto` 开自动 prune |
| `extensions/agents-context` | 补充加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· `PI_AGENTS_CONTEXT=0` |
| `extensions/settings-env` | 从全局和项目 `settings.json` 的顶层 `env` 读取变量并注入 Pi 进程；已有环境默认优先。 | `env` · `envOverride` |
| `extensions/memory` | Claude Code 风格自动长期记忆：零配置初始化、相关主题召回、每轮按需提炼并去重更新 `.pi/memory`。 | `/memory [list\|show\|init]` · `/remember <text>`（均为可选手动入口） |
| `extensions/approvals` | 唯一审批闸门:权限模式 × 规则库 × 命令安全 × 受保护路径 × MCP 逐工具，统一 allow/ask/deny。 | `/approvals [mode\|rules\|allow\|ask\|deny\|remove]` |
| `extensions/plan-mode` | 只读规划闸门:仅可探查，模型提交计划经批准后才恢复写工具。 | `/plan [on\|off]` · `Alt+P` · `exit_plan_mode` |
| `extensions/behavior` | 向系统提示词追加「工作准则」：Codex 式自主性 + Claude Code 式工程规则（默认开）。 | `--behavior=false` · `PI_BEHAVIOR=0` |
| `extensions/profiles` | 命名配置预设（模型+工具+thinking+审批）一键保存/切换/删除。 | `/profile [save\|apply\|delete\|<name>]` · `--profile <name>` |
| `extensions/resume-picker` | 会话恢复选择器 + 跨项目会话全文检索（rg），命中后切回历史会话。 | `/resume-picker [--all] [过滤词]` · `/search <关键词>` |
| `extensions/autopilot` | 自主续跑控制器:自动注入隐藏 follow-up 连续推进，按预算/轮数/收益递减停止。 | `/autopilot [on [目标]\|off\|status]` |
| `extensions/local-models` | 发现本地大模型运行时（Ollama、LM Studio）并注册为 localhost OpenAI 兼容 provider。 | `/local-models [list\|pull\|ensure_ready]` · `/ollama` · `/lm` |
| `extensions/codebuddy-reasoning` | 对齐 CodeBuddy 原生 `gpt-5.6-sol` 请求参数，使 High thinking 返回并展示可见推理摘要。 | （无命令，自动生效） |
| `extensions/webfetch` | 客户端联网抓取（移植 Claude WebFetch）:URL→fetch→HTML 转 markdown 交模型阅读;SSRF 防护(私有段+连接前 DNS 守卫)、10MB 流式截断、15min 缓存。 | 工具 `webfetch` · `--webfetch`（默认开） |
| `extensions/mcp` | 内置 MCP 客户端:读 `.pi/mcp.json` 连 server，暴露 `mcp__<server>__<tool>`，审批由 approvals 兜底。 | `/mcp [list\|status\|add\|remove\|reconnect]` |
| `extensions/plugin-loader` | Claude 风格插件管理器：Marketplace、安装/更新/卸载、user/project/local scope，并接入 skills/commands/themes/styles/hooks/agents/MCP。 | `/plugin` · `/plugin marketplace …` · `/plugin install\|remove\|update …` |
| `extensions/hooks-runner` | 配置驱动 hook 框架:把 Pi 生命周期事件桥接到 Claude Code JSON hook 协议，可拦截/改写/注入。 | `/hooks` · `.pi/hooks.json` |
| `extensions/agents` | 加载 Claude 风格 subagent 角色 `.md` + 内置角色库，应用到当前会话（收敛工具 + 注入系统提示）。 | `/agents [list\|show <name>\|use <name>]` |
| `extensions/migrate` | 一次性把 Claude/Cursor 的 MCP、subagents、commands、hooks、memory 导入 `.pi/`，只导缺失不覆盖。 | `/migrate [category]` · `--dry-run` |
| `extensions/monitor` | 只读效果监控:缓存命中率、上下文构成、清理/压缩回收比，面板 + footer 展示。 | `/monitor` |
| `extensions/cost-usage` | 只读追踪会话美元成本、按模型 token、时长与编辑增删行，并在 OAuth 模式查看 Codex 订阅套餐额度与重置时间。 | `/cost` · `/usage` |

## 命令

### `/diff`

显示当前 git 工作树 diff，包括未跟踪文件。在非 git 仓库中会显示：

```text
`/diff` — _not inside a git repository_
```

### `/review`

在交互模式下打开以下预设：

- 对比基准分支进行评审（PR 风格）
- 评审未提交变更
- 评审某个提交
- 自定义评审指令

### `/review <instructions>`

直接向 agent 发送自定义评审指令，不打开预设选择器。

## Subagent 工具

此包注册了 Codex 风格的多 agent 工具：

- `spawn_agent` 启动一个后台 `pi --mode rpc --no-session` 子 agent，并立即返回任务名和状态。默认不继承主 agent 会话上下文。只有当工具调用显式传入 `fork_context: true` 时，扩展会 clone 当前 Pi session 的 active branch，并用 `pi --mode rpc --session <forked-session>` 启动子 agent。
- `wait_agent` 等待某个 subagent 的邮箱更新或超时。
- `send_message` 向运行中的 subagent 发送引导消息；如果该 subagent 空闲，则启动新的提示轮次。
- `followup_task` 向运行中的 subagent 排队后续任务；如果该 subagent 空闲，则启动新的提示轮次。
- `list_agents` 列出当前 Pi 会话中的 subagents。
- `close_agent` 中止并关闭 subagent 进程。

`fork_context` 是显式 opt-in。模型不应因为任务复杂或需要并行分析就自动启用它；只有当用户明确要求 fork、clone、继承当前完整上下文，或让 subagent 使用当前会话上下文时才应设置为 `true`。如果当前主会话没有持久化 session 文件，fork 模式会报错；普通模式仍可使用。

折叠后的 TUI 行使用 Codex 风格摘要：已启动 agent、已发送输入、等待中、等待结束、已关闭 agent。展开后的行显示 Pi 特定的调试信息，例如最近的子进程工具调用、stderr 预览和用量计数。这些信息只用于 UI 可观测性，不会作为完整日志返回给父模型。

在交互式 TUI 中，`extensions/subagents` 还会在聊天输入框下方显示当前 `starting` / `running` 的 subagent 列表。列表只作为 UI 状态提示，不会写入模型上下文；所有 subagent 都结束后该提示会自动消失。

## `/side`

`/side [message]` 打开 Codex 风格的临时 side conversation。它在 Pi 原生 overlay 中使用当前主模型发起独立、无工具的临时对话；关闭 overlay（Esc 或 Ctrl+C）会中止请求并丢弃 side 历史，主会话不会切换，也不会收到 side 的历史。

这个实现复刻 Codex `/side` 的核心语义：继承当前 leaf 的上下文作为参考、使用 side boundary 指令、默认只做轻量非修改探索。继承上下文通过 Pi 原生 `buildSessionContext` 重建，遵守已有 compaction 边界，并复用 context-pipeline 的发送前裁剪；若临时 side 历史仍接近模型窗口，会优先丢弃最旧的完整 turn。它不使用系统新终端窗口或 tmux split。

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

## Imagegen 生图

`extensions/imagegen` 使用 `~/.pi/agent/models.json` 中 `type: "image"` 的 provider 配置。第一版支持 OpenAI Images API。为了让该配置仍通过 Pi 原生 `models.json` 校验，image provider 也要带上一个 Pi 已知的 `api` 和空的 `models` 数组；真正的生图模型放在 extension 自定义的 `imageModels` 中：

```json
{
  "providers": {
    "openai-image": {
      "type": "image",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "OPENAI_API_KEY",
      "api": "openai-responses",
      "models": [],
      "imageModels": [
        {
          "id": "gpt-image-1",
          "name": "GPT Image 1",
          "api": "openai-images",
          "defaultSize": "1024x1024",
          "defaultFormat": "png"
        }
      ]
    }
  }
}
```

`apiKey` 支持环境变量名或直接写入 key；推荐使用环境变量名，例如上例中的 `OPENAI_API_KEY`。

`generate_image` 会生成图片并保存到 `~/.pi/agent/generated_images/<date>/<tool-call-id>.png`，工具结果只返回文本路径，不返回图片 bytes，避免图片内容进入模型上下文。工具会用 custom entry 记录生成图片索引，这类 entry 不参与 LLM 上下文。

`/images` 会打开一个 TUI 图片展示器，列出当前有效 LLM 上下文中提到的本地图片路径，以及本扩展生成并记录的图片路径；它不会扫描磁盘目录。也支持手动输入 path 后预览。预览只发生在 UI 层，不写入 LLM 上下文。终端 inline 图片显示依赖 Kitty/Ghostty/WezTerm/iTerm2 等支持图片协议的终端；Pi TUI 当前在 tmux/screen 中会保守禁用图片协议，因此 tmux 下通常只会提示路径，建议在外层终端直接运行 Pi 或用终端自己的图片打开方式查看。

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

Subagent 的 `fork_context: true` 已支持基于 Pi session clone 的显式上下文 fork。agent 角色/配置文件，以及跨会话 subagent 恢复仍暂缓实现。
