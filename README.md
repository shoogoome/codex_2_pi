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
| `extensions/fast-mode` | Codex Fast service tier：仅对支持的 openai-codex OAuth 模型注入 `service_tier: "priority"`，约 1.5× 速度但增加额度消耗。 | `/fast [on\|off\|status]` · `--fast` |
| `extensions/ultra` | GPT-5.6 Sol/Terra 的 Codex Ultra controller：会话态 `ultra`、wire `max`，自动激活 `task_agent` 并注入并行 multi-agent workflow。 | 由 `/effort ultra` 或 `/model` 高级选择器进入 |
| `extensions/compact-ui` | Codex 风格紧凑 UI:消息前缀化 + 常见内置工具短渲染（与 claude-ui 互斥）。 | （`--claude-ui=false` 回退到此皮肤） |
| `extensions/pets` | Codex 风格终端宠物 widget，依 agent 状态切换动画，Kitty graphics/tmux passthrough 可选，其余回退 block-art。 | （无命令，自动 widget） |
| `extensions/goal` | Codex 风格 thread goal:持久目标 + 预算消耗 + 续跑提示，随 session 保存。 | `get_goal` / `create_goal` / `update_goal` · `/goal <objective>` · `/goal resume` |
| `extensions/localagent` | 注册 `task_agent` + `local_agent` 任务类型，进程内运行一次性/后台/fork 子 agent；默认继承当前 model + reasoning，可显式覆盖，并按 agent role 收敛工具。 | `task_agent` |
| `extensions/localshell` | 注册 `task_bash` 工具 + LocalShellTask：前台完成只保留一条 Bash 工具结果，超时转后台；后台终态默认在空闲时即时、忙时于 agent_end 安全边界更新 TUI，不打断/注入 LLM，调用头、输出 gutter、颜色和折叠与 Claude UI 的 `Bash` 一致。 | `task_bash` · `task_status` / `task_kill` · `PI_TASK_BASH_TIMEOUT_MS` 调默认超时 · `PI_TASKS_WAKE_ON_BACKGROUND=1` 可恢复 Claude 式主动唤醒 |
| `extensions/tasks` | 任务框架底座:default TaskStore + 背景 agents panel（Ctrl+Y 焦点 / Enter overlay）+ 任务查询管理工具。 | `task_status` / `task_kill` / `task_list` |
| `extensions/teammate` | 长生命周期多 agent 团队协作：完整 `name@team` 隔离、自动结果回传、持久消息重放、硬写审批、共享任务看板与安全 resume。 | `team_create` / `task_agent(team_name+name)` / `send_message` / `request_plan_approval` / `team_delete` / `team_plan_approve` |

### 新增扩展（Codex + Claude Code 能力移植）

| 扩展 | 能力 | 主要命令 / 入口 |
|---|---|---|
| `extensions/claude-ui` | Claude Code 风格无边框 TUI 皮肤:● 助手前导、用户灰底整行、工具去背景盒 ⎿、整行底色 diff、长输出折叠。 | `--claude-ui`（默认开）· `Ctrl+O` 展开 |
| `extensions/input-history` | 跨会话输入历史持久化 + 反向增量搜索。 | `Alt+R`（可改绑 `ctrl+r`） |
| `extensions/context-pipeline` | 分层上下文管理：按预算截断 tool_result、microcompact 清旧结果（默认手动，保护 prompt 缓存），并为 Pi 原生压缩生成结构化摘要。 | `/prune [status\|soft\|hard]` · `/context-prune` · `--prune-auto` / `PI_CTXPIPE_PRUNE_MODE=auto` 开自动 prune |
| `extensions/compact-continue` | Pi 阈值压缩后保守判断是否仍有工作：仅在 toolResult、截断/tool-use 回合或未完成计划等强信号下隐藏续跑一次，并让真实用户/自动队列优先。 | `--compact-continue`（默认开）· `--compact-continue=false` 关闭 |
| `extensions/agents-context` | 补充加载 `AGENTS.md`/`CLAUDE.md`、`.claude/rules`、`@include`、条件 paths 规则，去重后隐藏注入。 | `--agents-context`（默认开）· `PI_AGENTS_CONTEXT=0` |
| `extensions/settings-env` | 从全局和项目 `settings.json` 的顶层 `env` 读取变量并注入 Pi 进程；已有环境默认优先。 | `env` · `envOverride` |
| `extensions/channel` | 多 Channel 通信中心：TUI 面板管理具名 HTTP/微信 ClawBot 通道，支持当前/多选/全部会话范围、入站/出站/双向限制；Pi 可感知名称并用 `channel_send` 路由阶段产物。认证由协议适配器提供，兼容原 `PI_CHANNEL_*` 单 HTTP 入站配置。 | `/channel` 面板 · `channel_send` · `/channel status\|restart\|auth\|login\|send` |
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
| `extensions/web` | 浏览器 Web UI：管理整机 `~/.pi/agent/sessions` 的 Pi 会话并从 CLI 到 Web 聊天；后端零依赖 HTTP + SSE，每个会话一个 `pi --mode rpc` 子进程，支持流式事件/工具调用/图片/审批对话框。 | `/web` · `/web status\|stop` · `--web` / `--web-host` / `--web-port` / `--web-token` |

## Named Channels（HTTP + 微信 ClawBot）

执行 `/channel auth`（`/channel login` 是兼容别名）会打开通用认证目标选择器：选择已有 Channel，或选择某个支持认证的协议来新建 Channel。当前首个认证适配器是微信 ClawBot，选中后扫码即可；后续 OAuth、设备码等协议可注册自己的认证适配器，不会把 `login` 固定等同于微信。也可执行 `/channel` 打开类似 `/plugin` 的配置面板，在列表按 `l` 打开同一通用认证选择器。

- **作用域**：默认多会话（在各会话面板按 `m` 挂载），也可选全部会话；旧单会话配置自动迁移为多会话挂载。
- **方向**：每个 Pi 会话可分别设置对端 → Pi、Pi → 对端或双向；微信只由一个会话长轮询，再把入站消息分发给所有允许入站的挂载会话，所有允许出站的会话都可共享发送。
- **协议**：HTTP 入站 listener + 出站 callback；微信 iLink/ClawBot 扫码登录、文本收发，以及可信 CDN 下载/AES 解密后的图片入站分析。
- **名称路由**：Pi 每轮感知已挂载 Channel 名称；用户从微信要求“给 `产物群` 发送阶段结果”时，Pi 可调用 `channel_send(channel="产物群", ...)`。

原有环境变量配置保持兼容：设置 `PI_CHANNEL_TOKEN` 仍会得到只读的 `legacy-http` 入站 Channel，默认监听 `0.0.0.0:4317`。HTTP 入站继续使用 `POST /v1/messages`、Bearer 鉴权、幂等和限流：

```bash
curl "http://<机器IP>:4317/v1/messages" \
  -H "Authorization: Bearer $PI_CHANNEL_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"source":"alertmanager","content":"生产环境出现告警，请检查"}'
```

配置保存在私有文件 `~/.pi/agent/channel/config.json`（`0600`）；微信凭证按 Channel 隔离保存。完整面板操作、协议字段、安全限制及扫码流程见 [`docs/extensions/channel.md`](docs/extensions/channel.md)。

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

## 多 Agent 工具

当前多 Agent 实现统一由 `extensions/localagent`、`extensions/tasks` 和 `extensions/teammate` 提供；旧的 RPC `extensions/subagents`、`spawn_agent`、`wait_agent`、`followup_task`、`close_agent` 工具链已经移除。

### `task_agent` 与 teammate

`extensions/localagent` 的 `task_agent` 是一条**进程内**执行路径：省略 `team_name`/`name` 时运行一次性或后台 agent，使用 `run_in_background: true` 可后台化；省略 `subagent_type` 则 fork 当前有效上下文。子 agent 默认继承父会话当前 model 与 reasoning，只有显式传 `model` 才覆盖；实际 SDK 从当前 `pi` CLI 旁解析，避免项目开发依赖版本漂移。agent role 的 `tools`/`disallowedTools` 会真正约束子会话；未指定 tools 的自定义角色安全默认只读，内置 `general-purpose` 显式拥有当前可用工具（递归/团队管理工具仍移除）。后台 agent 结束时会把有界最终回答随终态通知自动送回 leader，完整轨迹仍保存在 `output_file`。

localagent 与 teammate 共用根会话容量控制：默认最多 6 个驻留线程、4 个同时执行线程（都包含 leader，即最多 5 个驻留/3 个执行中的子 Agent）；可通过 `PI_AGENT_MAX_THREADS` 和 `PI_AGENT_MAX_CONCURRENT` 调整。teammate 仅在实际 turn 占执行槽，idle 时只占驻留槽；超过执行上限的工作按 FIFO 等待，取消、失败、kill 和 session 切换都会释放或重置配额。

同时传 `team_name` 与 `name` 会创建长生命周期 teammate。成员用完整 `name@team` 路由：裸名称只有在 team 内（leader 侧则要求跨 team 唯一）才解析，广播也不会越 team。每轮最终回答和错误会自动注入 leader；成员间消息以 `message_sent → message_ack` 持久化，未 ACK 消息在 resume 后按序重放。team task 工具绑定 leader-realm 共享 store，并强制成员只能访问自己的 team。写文件、变更 shell 和 MCP 调用由运行时硬门禁拦截，只有 `request_plan_approval` 获批后才在当前 turn 开放；恢复时若原 role 被删除或定义指纹变化则 fail-closed，不会回退到 `general-purpose`。`session_shutdown` 会挂起成员供下一会话重建；显式 `team_delete` 才执行 shutdown handshake 和超时强制清理。详见 [多 Agent 说明](docs/extensions/multi-agent.md)。

## `/effort` 与 Codex Ultra

`/effort` 不带参数时打开当前模型的推理档位选择器，`/effort status` 查看有效档位；普通档位调用 Pi 原生 thinking level。与 Codex 一样，Max/Ultra 收在第二层 `More reasoning…` 高级选择器中，`Alt+,` / `Alt+.` 可降低/提高普通档位，但提高操作不会静默跨入 Max/Ultra。交互式 `/model [过滤词]` 也会按“模型 → 推理档位”原子选择，取消档位选择不会先切模型。

Ultra 的入口属于 reasoning effort，但实现独立放在 `extensions/ultra`：仅对 `openai-codex/gpt-5.6-sol` / `gpt-5.6-terra` 开放；会话中保留客户端态 `ultra`，provider 请求发送原生 `max`。启用时 controller 会自动激活已注册的 `task_agent`，同时注入 Codex proactive policy 和明确工作流：存在至少两个独立工作流时并行委派，leader 同时推进独立工作，等待自动终态通知后综合；简单任务不强行并行。Plan 模式下 workflow 暂停且不会绕过只读边界，退出后恢复；关闭 Ultra 时只撤销 Ultra 自己激活的 tool。footer/status 会显示 workflow active 或暂停原因。

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

`task_agent` 已支持基于 Pi session 的完整上下文 fork、自定义 agent role、共享并发/权限边界，以及长生命周期 teammate 的安全跨会话恢复。选择性继承最近 N 轮上下文、根会话级 token/费用硬预算和嵌套 Agent 仍暂缓；递归 spawn 继续关闭。
