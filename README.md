# Pi Codex Replica

一个独立的 Pi 包，用于在不修改 Pi 核心的情况下复刻部分 Codex CLI 能力。

## 包含的扩展

| 扩展 | 能力 |
|---|---|
| `extensions/diff` | 添加 `/diff`，展示已跟踪和未跟踪的 git 变更。 |
| `extensions/review` | 添加 `/review`，提供 Codex 风格的评审预设。 |
| `extensions/user-input` | 添加 `request_user_input`、`ask_user_question` 和 `askUserQuestion` 工具。 |
| `extensions/subagents` | 添加 Codex 风格的 subagent 工具，由 Pi RPC 子进程驱动。 |
| `extensions/init` | 添加 `/init`，通过主 agent 创建项目 `AGENTS.md` 指南。 |
| `extensions/imagegen` | 添加 `generate_image` 生图工具和 `/images` 图片路径展示器。 |
| `extensions/todo` | 添加 Codex 风格 `update_plan` 工具、计划更新渲染和常驻 plan overlay。 |

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

`/side` 有意未包含。Codex 的 `/side` 依赖临时线程状态和 Ctrl+C 返回行为，如果没有 Pi 核心支持，无法通过 Pi 扩展完整复现。

Subagent 的 `fork_context: true` 已支持基于 Pi session clone 的显式上下文 fork。agent 角色/配置文件，以及跨会话 subagent 恢复仍暂缓实现。
