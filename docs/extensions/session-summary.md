# session-summary

`extensions/session-summary` 在输入框上方常驻显示一份可扫读的 `summary`：

- 每条真实用户输入生成一行 `你` 摘要；
- 每次完整 `agent_end`（包括其中的多轮工具调用）生成一行 `AI` 工作摘要；
- 用完整边框包住标题、摘要和当前位置，避免与聊天区混在一起；框内标题（`summary`）、角色、摘要、等待提示和滚动信息全部使用灰色弱化显示，不抢主对话视觉焦点；
- 默认显示最近 8 行，可通过 settings 设置 2-30 行；使用 `Alt+↑` 向旧记录滚动、`Alt+↓` 回到新记录，底边会显示 `起止/总数` 和上下方剩余条数；
- 摘要写入 session `CustomEntry`，恢复会话或切换分支时会随当前 branch 恢复，但不会进入 LLM 上下文。

空会话也会保留带边框的“等待首轮对话”区域，因此用户始终能看到这个常驻组件。新摘要到达时默认跟随最新内容；如果用户正在查看旧记录，则保持当前窗口稳定，不会强制跳到底部。

## 独立摘要模型

默认继承当前主模型，但摘要请求通过 `completeSimple` 独立调用，**不会切换主会话模型**。推荐一次设置所有会话使用的全局小模型：

```text
/session-summary model global openai/gpt-4o-mini
/session-summary model global mini
```

全局模型和展示条数保存在 Pi 的 `~/.pi/agent/settings.json`（实际路径遵守 `PI_CODING_AGENT_DIR`）的同一个配置段中：

```json
{
  "sessionSummary": {
    "model": "openai/gpt-4o-mini",
    "lines": 8
  }
}
```

新会话自动使用；已经打开的其他会话会在生成下一条摘要前重新读取，因此无需逐个重启。清除全局默认：

```text
/session-summary model global inherit
```

也可以只覆盖当前会话：

```text
/session-summary model session openai/gpt-4o-mini
/session-summary model session inherit
```

省略 scope 的 `/session-summary model <模型>` 默认等价于 `model global <模型>`，因此普通设置只需执行一次。只有需要覆盖某个会话时才显式使用 `model session`。`session inherit` 清除当前会话覆盖，回退到全局默认；没有全局默认时才跟随主模型。

不带模型名时，交互模式会打开已认证模型选择器：

```text
/session-summary model global
/session-summary model session
```

启动时也可指定：

```bash
pi --session-summary-model openai/gpt-4o-mini
```

模型参数支持：

1. 精确 `provider/model`；
2. 精确 model id；
3. 唯一的 provider、id 或展示名子串。

模糊结果不唯一时，交互模式会继续让用户选择；非交互模式要求改用精确 `provider/model`。

模型优先级为：`--session-summary-model` 启动参数 > 当前会话覆盖 > 全局默认 > 当前主模型。

## 命令

```text
/session-summary status
/session-summary on
/session-summary off
/session-summary clear
/session-summary lines <2-30|inherit>
/session-summary model [global|session] [provider/model|inherit]
```

- `status`：查看开关、有效模型及其来源、全局默认、记录数、显示行数和最近错误；
- `on` / `off`：会话内持久开关；
- `clear`：清空当前 branch 后续可见的摘要记录；
- `lines`：把所有会话共用的展示条数写入 `settings.json`；`inherit` 清除设置并恢复默认 8 条；
- `model global`：把所有会话的默认摘要模型写入 `settings.json`；
- `model session`：仅覆盖当前会话；`inherit` 清除对应层级的设置。

## Flags 与环境变量

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `--session-summary` / `--session-summary=false` | 开 | 启用或禁用常驻摘要 |
| `--session-summary-model <query>` | 未设置 | 为当前 Pi 进程强制指定摘要模型，优先于会话和全局配置 |
| `--session-summary-lines <2-30>` | 未设置 | 仅覆盖当前 Pi 进程的展示条数；默认读取 `settings.json`，没有配置时为 8 |
| `PI_SESSION_SUMMARY=0` | 未设置 | 强制关闭 |

## 摘要时机与降级

用户输入到达时会立即显示一条本地单行压缩结果，再在后台用摘要模型精炼；主 Agent 不需要等待。Agent 完整结束时也会立即显示最终回答的本地压缩，再异步精炼。模型不可用、认证失败或返回空内容时，保留本地结果，并在标题显示 `fallback`；可用 `/session-summary status` 查看原因。

用户行只捕获 `interactive` / `rpc` 的非斜杠输入，避免把 `/cost`、autopilot、loop 等扩展生成的指令冒充为用户发言；扩展触发的 Agent run 仍会产生 `AI` 工作摘要。

## 发送给摘要模型的内容

- 用户摘要：该条用户文本；
- Agent 摘要：本次 run 中的用户文本、Assistant 可见文本和调用过的工具名；
- **不会发送 tool result 内容或工具参数**，避免把文件内容、命令输出等额外扩散给独立模型。

摘要模型输出被限制为单行短文本。扩展最多在内存中保留最近 100 条摘要，常驻区只渲染 `settings.json` 的 `sessionSummary.lines`（或启动参数覆盖）指定的最近若干条。
