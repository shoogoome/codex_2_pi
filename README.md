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
| `extensions/imagegen` | Codex 订阅生图：复刻 codex 内置 `image_gen.imagegen`，走 openai-codex OAuth 直连 ChatGPT 图片 API（gpt-image-2），生成/编辑结果保存到 `~/.pi/agent/generated_images/<session>/` 并回传给模型检查迭代。 | `generate_image` |
| `extensions/todo` | Codex 风格 `update_plan`（整份计划快照）+ 计划渲染 + 常驻 plan overlay。 | `update_plan` |
| `extensions/effort` | 通用 thinking 档位、Codex 风格两级高级选择器、`/model` 模型+档位原子选择，以及 `Alt+,` / `Alt+.` 升降快捷键。 | `/effort [status\|off\|minimal\|low\|medium\|high\|xhigh\|max\|ultra]` · `/model` |
| `extensions/ultra` | GPT-5.6 Sol/Terra 的独立 Codex Ultra controller：会话态 `ultra`、请求下沉 `max`、主动 multi-agent 政策、恢复语义和 TUI 状态。 | 由 `/effort ultra` 或 `/model` 高级选择器进入 |
| `extensions/compact-ui` | Codex 风格紧凑 UI:消息前缀化 + 常见内置工具短渲染（与 claude-ui 互斥）。 | （`--claude-ui=false` 回退到此皮肤） |
| `extensions/pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `extensions/goal` | Codex 风格 thread goal:持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | `get_goal` / `create_goal` / `update_goal` · `/goal <objective>` · `/goal resume` |
| `extensions/localagent` | 注册 `task_agent` + `local_agent` 任务类型，进程内运行一次性/后台/fork 子 agent；默认继承当前 model + reasoning，可显式覆盖，并按 agent role 收敛工具。 | `task_agent` |
| `extensions/localshell` | 注册 `task_bash` 工具 + LocalShellTask：前台完成只保留一条 Bash 工具结果，超时转后台；后台终态默认在空闲时即时、忙时于 agent_end 安全边界更新 TUI，不打断/注入 LLM，调用头、输出 gutter、颜色和折叠与 Claude UI 的 `Bash` 一致。 | `task_bash` · `task_status` / `task_kill` · `PI_TASK_BASH_TIMEOUT_MS` 调默认超时 · `PI_TASKS_WAKE_ON_BACKGROUND=1` 可恢复 Claude 式主动唤醒 |
| `extensions/tasks` | 任务框架底座:default TaskStore + 背景 agents panel（Ctrl+Y 焦点 / Enter overlay）+ 任务查询管理工具。 | `task_status` / `task_kill` / `task_list` |
| `extensions/teammate` | 长生命周期多 agent 团队协作：成员继承父会话 model + reasoning、按 role 获得工具，经身份绑定通道主动回传 leader，并支持计划审批、任务看板、resume 与优雅关闭。 | `team_create` / `task_agent(team_name+name)` / `send_message` / `request_plan_approval` / `team_delete` / `team_plan_approve` |

### 新增扩展（Codex + Claude Code 能力移植）

| 扩展 | 能力 | 主要命令 / 入口 |
|---|---|---|
| `extensions/claude-ui` | Claude Code 风格无边框 TUI 皮肤:● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· `Ctrl+O` 展开 |
| `extensions/input-history` | 跨会话输入历史持久化 + 反向增量搜索。 | `Alt+R`（可改绑 `ctrl+r`） |
| `extensions/context-pipeline` | 分层上下文管理：按预算截断 tool_result、microcompact 清旧结果（默认手动，保护 prompt 缓存），并为 Pi 原生压缩生成结构化摘要。 | `/prune [status\|soft\|hard]` · `/context-prune` · `--prune-auto` / `PI_CTXPIPE_PRUNE_MODE=auto` 开自动 prune |
| `extensions/compact-continue` | Pi 阈值压缩后保守判断是否仍有工作：仅在 toolResult、截断/tool-use 回合或未完成计划等强信号下隐藏续跑一次，并让真实用户/自动队列优先。 | `--compact-continue`（默认开）· `--compact-continue=false` 关闭 |
| `extensions/agents-context` | 补充加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· `PI_AGENTS_CONTEXT=0` |
| `extensions/settings-env` | 从全局和项目 `settings.json` 的顶层 `env` 读取变量并注入 Pi 进程；已有环境默认优先。 | `env` · `envOverride` |
| `extensions/channel` | 通用外部 HTTP 入站 Channel：Bearer 鉴权、幂等/限流、会话发现，并用 steer/follow-up/next-turn 语义把事件注入当前 Pi 会话。默认监听 `0.0.0.0:4317`，仅配置 `PI_CHANNEL_TOKEN` 后启动。 | `/channel [status\|restart]` · `POST /v1/messages` |
| `extensions/memory` | Claude Code 风格自动长期记忆：零配置初始化、相关主题召回、每轮按需提炼并去重更新 `.pi/memory`。 | `/memory [list\|show\|init]` · `/remember <text>`（均为可选手动入口） |
| `extensions/approvals` | 唯一审批闸门:权限模式 × 规则库 × 命令安全 × 受保护路径 × MCP 逐工具，统一 allow/ask/deny。 | `/approvals [mode\|rules\|allow\|ask\|deny\|remove]` |
| `extensions/plan-mode` | 只读规划闸门:仅可探查，模型提交计划经批准后才恢复写工具。 | `/plan [on\|off]` · `Alt+P` · `exit_plan_mode` |
| `extensions/behavior` | 向系统提示词追加「工作准则」：Codex 式自主性 + Claude Code 式工程规则（默认开）。 | `--behavior=false` · `PI_BEHAVIOR=0` |
| `extensions/profiles` | 命名配置预设（模型+工具+thinking+审批）一键保存/切换/删除。 | `/profile [save\|apply\|delete\|<name>]` · `--profile <name>` |
| `extensions/resume-picker` | 会话恢复选择器 + 跨项目会话全文检索（rg），命中后切回历史会话。 | `/resume-picker [--all] [过滤词]` · `/search <关键词>` |
| `extensions/autopilot` | 自主续跑控制器:自动注入隐藏 follow-up 连续推进，按预算/轮数/收益递减停止。 | `/autopilot [on [目标]\|off\|status]` |
| `extensions/loop` | Claude Code 风格定时循环：立即执行一次提示词，之后在 agent 空闲时按间隔重复；会话内生效并自动过期。 | `/loop [interval] <prompt>` · `/loop list` · `/loop cancel <id\|all>` |
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

## External HTTP Channel

配置 `PI_CHANNEL_TOKEN` 后，`extensions/channel` 会监听 `0.0.0.0:4317`（host/port 可通过 `PI_CHANNEL_HOST`、`PI_CHANNEL_PORT` 覆盖），让外部告警、CI、IDE 或定时任务向当前 Pi 会话投递消息并按需唤醒模型：

```bash
curl "http://<机器IP>:4317/v1/messages" \
  -H "Authorization: Bearer $PI_CHANNEL_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: alert-123" \
  -d '{"source":"alertmanager","content":"生产环境出现告警，请检查","delivery":"steer","wake":true}'
```

接口返回 `202 Accepted` 只代表消息已进入 Pi；不会同步等待模型回答。`/channel status` 查看监听与发现文件，完整协议、安全限制和配置见 [`docs/extensions/channel.md`](docs/extensions/channel.md)。

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

### `task_agent` 与 teammate

`extensions/localagent` 的 `task_agent` 是另一条**进程内**执行路径：省略 `team_name`/`name` 时运行一次性或后台 agent，使用 `run_in_background: true` 可后台化；省略 `subagent_type` 则 fork 当前有效上下文。子 agent 默认继承父会话当前 model 与 reasoning，只有显式传 `model` 才覆盖；实际 SDK 从当前 `pi` CLI 旁解析，避免项目开发依赖版本漂移。agent role 的 `tools`/`disallowedTools` 会真正约束子会话；未指定 tools 的自定义角色安全默认只读，内置 `general-purpose` 显式拥有当前可用工具（递归/团队管理工具仍移除）。

同时传 `team_name` 与 `name` 会创建长生命周期 teammate。teammate 使用同一套 role 解析和 model/reasoning 继承，拥有身份绑定的 `send_message`、计划审批及 team task 工具；给 leader 的消息会主动注入主会话，而不是依赖轮询。团队在 session resume 时恢复；`session_shutdown` 以不写 terminal 事件的方式挂起成员，下一会话可重建；显式 `team_delete` 才会先执行 shutdown handshake，再对超时成员强制清理。

## `/effort` 与 Codex Ultra

`/effort` 不带参数时打开当前模型的推理档位选择器，`/effort status` 查看有效档位；普通档位调用 Pi 原生 thinking level。与 Codex 一样，Max/Ultra 收在第二层 `More reasoning…` 高级选择器中，`Alt+,` / `Alt+.` 可降低/提高普通档位，但提高操作不会静默跨入 Max/Ultra。交互式 `/model [过滤词]` 也会按“模型 → 推理档位”原子选择，取消档位选择不会先切模型。

Ultra 的入口属于 reasoning effort，但实现独立放在 `extensions/ultra`：仅对 `openai-codex/gpt-5.6-sol` / `gpt-5.6-terra` 开放；会话中保留客户端态 `ultra`，provider 请求发送原生 `max`，同时注入 Codex 的 proactive multi-agent mode。非 Ultra 时恢复 exact explicit-request-only mode。Ultra 状态随 session 分支持久化，resume/fork/tree/compaction 会重新应用；切换档位或不支持的模型会退出。footer 显示 `» ULTRA · multi-agent`，并在启用时给出一次性激活反馈。`task_agent` 未安装/未激活时会警告。

## `/side`

`/side [message]` 打开 Codex 风格的临时 side conversation。它在 Pi 原生 overlay 中使用当前主模型发起独立、无工具的临时对话；关闭 overlay（Esc 或 Ctrl+C）会中止请求并丢弃 side 历史，主会话不会切换，也不会收到 side 的历史。

这个实现复刻 Codex `/side` 的核心语义：继承当前 leaf 的上下文作为参考、使用 side boundary 指令、默认只做轻量非修改探索。继承上下文通过 Pi 原生 `buildSessionContext` 重建，遵守已有 compaction 边界，并复用发送前裁剪/LLM 可见性规则；进入独立 side 请求前会移除父线程专属的 encrypted reasoning 与 Responses item ID。若仍接近模型窗口，会优先丢弃最旧的完整 turn；服务端确认 overflow 时再以半窗口预算自动重试一次。它不使用系统新终端窗口或 tmux split。

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
