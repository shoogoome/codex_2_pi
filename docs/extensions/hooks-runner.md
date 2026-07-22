# hooks-runner

配置驱动的**用户 hook 框架**。它把 pi 的生命周期事件桥接到 Claude Code 的 JSON hook 决策协议上,让你为 Claude 写过的 `hooks.json`(`command` 类型)在 pi 下以相同的形状和语义运行:在工具调用前后、提交提示、会话开始/结束等时机执行你配置的脚本,脚本可以**拦截操作、改写工具参数、注入上下文**。

## 能力

- 从两个配置文件读取 hook 定义,并在 `session_start` 时合并。
- 把 7 个 pi 事件桥接到对应的 Claude hook 事件(见下表),每个 hook 通过 stdin 收到事件 JSON,通过退出码 / stdout JSON 返回决策。
- 决策可以:拦截工具调用、改写工具输入(`updatedInput`)、注入额外上下文、把工具结果标记为错误、改写用户提示、软性让 agent 继续、取消压缩(compact)。
- 首次运行某条 hook 命令前弹窗确认(信任门禁),批准后按命令内容的 SHA-256 记住;改命令会重新触发确认。
- `/hooks` 只读列出所有已配置 hook 及其信任状态。

### 事件桥接表

| pi 事件 | Claude hook 事件 | 决策可做什么 |
| --- | --- | --- |
| `tool_call` | `PreToolUse` | 拦截调用、改写 `event.input`(`updatedInput`)、注入上下文 |
| `tool_result` | `PostToolUse` | 向结果追加上下文、把结果标记为错误(`isError`) |
| `input` | `UserPromptSubmit` | 改写提示(追加上下文)或吞掉提示(拦截) |
| `agent_end` | `Stop` | 软性让 agent 再跑一轮(通过 `sendUserMessage` 重新提示,一次) |
| `session_start` | `SessionStart` | 注入启动上下文 / 初始消息 |
| `session_shutdown` | `SessionEnd` | fire-and-forget 清理(永不阻塞退出) |
| `session_before_compact` | `PreCompact` | 拦截时取消压缩 |

> `PreToolUse` / `SessionStart` 的 `additionalContext` 在 pi 里没有直接返回通道,会被缓冲并在下一次 `before_agent_start` 以 `display:false` 消息形式注入(与 goal 扩展同一模式)。过大的 hook 输出在注入前会被 `truncateHead` 截断(`DEFAULT_MAX_BYTES`)。

## 命令

### `/hooks`

只读。列出每个已配置事件、其 matcher、hook 命令(command 显示命令,http 显示 url,prompt/agent 显示 prompt)以及信任状态(`trusted` / `untrusted` / `phase-2`)。若尚未看到 `session_start` 会提示未加载;若无配置会提示添加配置文件。

## 工具

本扩展不向 LLM 注册可调用工具。它对模型的影响是间接的:通过注入 `<hook_context>...</hook_context>` 上下文、拦截操作、改写工具输入等。

## 配置

### 配置文件路径

`session_start` 时读取并合并两个文件(任一不存在都会被安全跳过):

- 全局:`~/.pi/agent/hooks.json`
- 项目:`<cwd>/.pi/hooks.json`

合并规则:按事件把项目的 matcher 块**追加到全局之后**(两者都运行,不删除任何一方)。

### 配置形状

接受 Claude settings 形状(顶层 `hooks` 键可选——裸事件映射也可):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "if": "Bash(git *)",
        "hooks": [
          { "type": "command", "command": "./scripts/guard.sh", "timeout": 10 }
        ]
      }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "./scripts/inject-context.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "./scripts/check-done.sh" }] }
    ]
  }
}
```

支持的事件名:`PreToolUse`、`PostToolUse`、`UserPromptSubmit`、`SessionStart`、`SessionEnd`、`Stop`、`PreCompact`。其它 Claude 事件(如 `SubagentStart`、`Notification`)会被跳过并告警。畸形 JSON、未桥接的事件名、无效 hook 条目都会被跳过并告警——解析永不抛错、永不阻塞启动。

### hook 条目字段

- `command`(必填,`command` 类型):要执行的命令,通过 `/bin/sh -c` 运行。
- `if`(可选):权限规则式预过滤,如 `Bash(git *)`。
- `timeout`(可选):**单位秒**(Claude 惯例);内部转为毫秒。未设时默认 60000ms(60 秒)。
- `shell` / `statusMessage`(command 类型,已解析,当前未用于执行行为)。
- 其它类型有各自字段:`prompt`/`agent` 有 `prompt`、`model`;`http` 有 `url`、`headers`。这些类型目前只解析不执行(见二期)。

### matcher(匹配)

- 空 / `"*"` / 缺省 → 匹配一切。
- `Bash`、`Write`、或 `Bash|Write|Edit` → 对任一管道段做精确匹配,**别名感知**(pi 的小写 `bash` 匹配 Claude 的 `Bash`,反之亦然;别名表:bash/read/edit/write/grep/find/ls/glob)。
- 其它 → 当作正则表达式(无效正则匹配不到任何东西,而非抛错)。

### `if` 预过滤(MVP 语义)

- 规则的工具名必须匹配事件的工具(别名感知),否则该 hook 被过滤掉。
- 对 `Bash`:命令必须以 glob 前缀(`*` 之前的文本)开头。
- 对其它工具:对 `path` / `file_path` / `pattern` 做尽力前缀匹配;若这些字段都不存在则放行运行。
- 非工具事件(`Stop`、`SessionStart` 等)忽略 `if`。
- matcher 级 `if` 门禁整个块,hook 级 `if` 门禁单条 hook。

## 决策协议

每个 hook 从 **stdin** 收到事件 JSON(同时镜像到 `PI_HOOK_INPUT` 环境变量作为兜底),通过以下方式返回决策:

- **退出码 2** → 拦截;`stderr` 成为原因(回喂给模型)。
- 退出码非 0 且非 2 → 非阻塞错误,不拦截。
- **stdout JSON** — 识别的字段:
  - `continue: false` → 拦截(原因取 `stopReason`,回退 `reason`)。
  - `decision: "block"` 配 `reason` → 拦截。
  - `systemMessage` → 通过 UI 通知呈现。
  - `hookSpecificOutput`:
    - `permissionDecision: "deny"` → 拦截(`allow` / `ask` 不拦截;原因取 `permissionDecisionReason`)。
    - `updatedInput` → 替换工具参数(PreToolUse)。
    - `additionalContext` → 在下一轮 agent 注入。
    - `initialUserMessage` → 缓冲为启动上下文(SessionStart)。
- **stdout 非 JSON**(不以 `{` 开头,或解析失败)→ 整段当作 `additionalContext`。

多条 hook 的决策按顺序合并:任一拦截即拦截(保留首个拦截的原因);`additionalContext` 拼接;`updatedInput` / `initialUserMessage` / `systemMessage` 取最后一个非空值。

### hook 收到的输入

stdin JSON 的公共字段:`session_id`、`transcript_path`、`cwd`、`hook_event_name`,再加事件特定负载。例如 PreToolUse 有 `tool_name`(已规范为 Claude 大写名)、`tool_input`、`tool_use_id`;PostToolUse 额外有 `tool_response`;UserPromptSubmit 有 `prompt`;Stop 有 `stop_hook_active`;SessionStart 有 `source`;SessionEnd 有 `reason`;PreCompact 有 `trigger`、`custom_instructions`。

## 信任门禁

某条 hook 的确切命令首次将要运行时,会通过 `ctx.ui.confirm` 请你确认。批准后把命令的 SHA-256 通过 `appendEntry`(自定义条目类型 `hooks_trust`)持久化,并在每次 `session_start` 从会话分支回放,重建可信集合。编辑命令会改变哈希、重新触发确认。**没有交互式 UI 时(print / RPC 模式),未信任的 hook 会被跳过而绝不自动运行**——一个保守的 fail-safe,保证无人值守会话永不执行未确认的命令。

## 用法示例

在项目里创建 `.pi/hooks.json`,拦截 `rm -rf`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "./scripts/deny-rm-rf.sh" }]
      }
    ]
  }
}
```

`deny-rm-rf.sh` 读 stdin,若命令含 `rm -rf` 则以退出码 2 拦截:

```sh
#!/bin/sh
input=$(cat)
cmd=$(printf '%s' "$input" | grep -o '"command":"[^"]*"')
case "$cmd" in
  *"rm -rf"*) echo "危险命令被 hook 拦截" >&2; exit 2 ;;
esac
```

会话内首次触发时 pi 会弹窗让你信任这条 hook;批准后本会话及后续(哈希回放)不再重复询问。运行 `/hooks` 可查看它已变为 `trusted`。

## 说明 / 注意

- **只有 `command` 类型 hook 在本 MVP 执行**。`prompt`、`agent`、`http` 类型会被解析、在 `/hooks` 中列出(标记 `phase-2`),但执行时被跳过并给出提示——留待二期。
- `Stop` 的"继续"是软性重新提示(`sendUserMessage`,`deliverAs: followUp`),用 `stop_hook_active` 标志防循环;pi 没有硬性的"阻止停止"返回通道。真实用户回合会重置该标志。
- `if` 条件是工具名 + 前缀 glob 的近似,并非 Claude 完整的权限规则求值。
- command hook 通过 `node:child_process.spawn("/bin/sh", ["-c", command])` 运行(而非 pi 的 `exec`/`execCommand`,因为后者无法向 stdin 传数据),以便按协议把事件 JSON 送到 stdin。
- 扩展入口 `pi.extensions` 指向 `dist/index.js`(构建产物);源码在 `extensions/hooks-runner/index.ts` + `src/*.ts`。
- 与其它扩展的协作:缓冲上下文并在 `before_agent_start` 以 `display:false` 注入的模式与 goal 扩展一致。
